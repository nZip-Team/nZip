// nzip-core - stdin/stdout JSON-RPC backend for nZip.
//
// All commands arrive from the parent TypeScript process as newline-delimited
// JSON on stdin. Every response is written as a single JSON line to stdout.
// Log messages (info/warn/error) go to stderr so they never corrupt the
// protocol stream.
//
// Protocol summary.
// Request  → {"reqId":"<id>","cmd":"<cmd>", ...cmdArgs}
// Response → {"reqId":"<id>","type":"result","ok":true,"data":{...}}
//
//	| {"reqId":"<id>","type":"result","ok":false,"error":"<msg>"}
//	| {"reqId":"<id>","type":"result","ok":false,"errorCode":<n>}
//	| {"reqId":"<id>","type":"progress","completed":<n>,"total":<n>}
//	| {"reqId":"<id>","type":"packStart"}
//
// Supported commands.
//
//	ping
//	session.getOrCreate  hash, galleryId
//	session.get          hash
//	session.update       hash, data:{...}
//	session.touch        hash
//	session.delete       hash
//	session.exists       hash
//	session.getAll
//	session.tryAcquireLock  hash, processId
//	session.refreshLock     hash, processId
//	session.releaseLock     hash, processId
//	download.start       hash, images[], downloadDir, filename, concurrentDownloads, debug
//	download.stop        hash
//	download.stopAll
//	download.hasActive   hash
//	download.cleanTempFiles  downloadDir, filename
//	download.packFormat  hash, downloadDir, filename, format, images
//	download.extractArchive  downloadDir, filename
//	shutdown
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

var Version = "dev"

// Command is the inbound JSON envelope.
type Command struct {
	ReqID string `json:"reqId"`
	Cmd   string `json:"cmd"`

	// session fields
	Hash      string          `json:"hash,omitempty"`
	GalleryID string          `json:"galleryId,omitempty"`
	ProcessID string          `json:"processId,omitempty"`
	Data      json.RawMessage `json:"data,omitempty"`

	// download fields
	Images              []string `json:"images,omitempty"`
	DownloadDir         string   `json:"downloadDir,omitempty"`
	Filename            string   `json:"filename,omitempty"`
	Format              string   `json:"format,omitempty"`
	ConcurrentDownloads int      `json:"concurrentDownloads,omitempty"`
	Debug               bool     `json:"debug,omitempty"`
}

// Response is an outbound JSON envelope.
type Response struct {
	ReqID     string `json:"reqId"`
	Type      string `json:"type"` // "result" | "progress" | "packStart"
	OK        *bool  `json:"ok,omitempty"`
	Error     string `json:"error,omitempty"`
	ErrorCode *int   `json:"errorCode,omitempty"`
	Data      any    `json:"data,omitempty"`
	Value     any    `json:"value,omitempty"` // scalar result (bool, etc.)
	Completed int    `json:"completed,omitempty"`
	Total     int    `json:"total,omitempty"`
}

var (
	stdoutEnc = json.NewEncoder(os.Stdout)
	stdoutMu  sync.Mutex
)

func send(r Response) {
	stdoutMu.Lock()
	defer stdoutMu.Unlock()
	if err := stdoutEnc.Encode(r); err != nil {
		logErr("Encode response: %v", err)
	}
}

func ok(reqID string, data any) {
	t := true
	send(Response{ReqID: reqID, Type: "result", OK: &t, Data: data})
}

func okValue(reqID string, v any) {
	t := true
	send(Response{ReqID: reqID, Type: "result", OK: &t, Value: v})
}

func fail(reqID string, msg string) {
	f := false
	send(Response{ReqID: reqID, Type: "result", OK: &f, Error: msg})
}

func failCode(reqID string, code int) {
	f := false
	send(Response{ReqID: reqID, Type: "result", OK: &f, ErrorCode: &code})
}

func logInfo(format string, args ...any) {
	logWithLevel("Info", format, args...)
}

func logWarn(format string, args ...any) {
	logWithLevel("Warn", format, args...)
}

func logErr(format string, args ...any) {
	logWithLevel("Error", format, args...)
}

func logWithLevel(level string, format string, args ...any) {
	color := ""
	reset := ""
	if os.Getenv("NO_COLOR") == "" {
		switch level {
		case "Info":
			color = "\x1b[34m"
		case "Warn":
			color = "\x1b[33m"
		case "Error":
			color = "\x1b[31m"
		default:
			color = "\x1b[35m"
		}
		reset = "\x1b[0m"
	}

	dateTimeStr := ""
	if strings.ToLower(os.Getenv("LOG_DATETIME")) != "false" {
		dateTimeStr = " " + time.Now().Format("2006-01-02 15:04:05")
	}

	clusterStr := ""
	clusterID := os.Getenv("CLUSTER_ID")
	if clusterID != "" {
		maxDigits := 2
		if clusterCount := os.Getenv("CLUSTER_COUNT"); clusterCount != "" {
			if c, err := strconv.Atoi(clusterCount); err == nil && c > 0 {
				maxDigits = len(strconv.Itoa(c - 1))
			}
		}

		if idNum, err := strconv.Atoi(clusterID); err == nil {
			clusterStr = fmt.Sprintf(" [%0*d]", maxDigits, idNum)
		} else {
			clusterStr = fmt.Sprintf(" [%s]", clusterID)
		}
	}

	fmt.Fprintf(os.Stderr, "[%s%s%s]%s%s: "+format+"\n", append([]any{color, level, reset, dateTimeStr, clusterStr}, args...)...)
}

const (
	// maxCommandBytes caps one command line; a longer one is rejected, the process keeps going.
	maxCommandBytes = 8 << 20
	// shutdownGrace bounds how long shutdown waits for in-flight jobs.
	shutdownGrace = 60 * time.Second
)

// core owns the stores and the in-flight work of one process.
type core struct {
	store *SessionStore
	dm    *DownloadManager

	// ctx is cancelled on shutdown; every job derives from it.
	ctx    context.Context
	cancel context.CancelFunc
	jobs   sync.WaitGroup

	// Session commands run on one worker, in order, so a busy database never stalls download.stop.
	sessionQueue chan Command
	sessionDone  chan struct{}
}

func newCore(store *SessionStore, dm *DownloadManager) *core {
	ctx, cancel := context.WithCancel(context.Background())
	c := &core{
		store:        store,
		dm:           dm,
		ctx:          ctx,
		cancel:       cancel,
		sessionQueue: make(chan Command, 1024),
		sessionDone:  make(chan struct{}),
	}
	go c.runSessionWorker()
	return c
}

func main() {
	// Determine DB path: env DB_PATH or <cwd>/Server/Cache/sessions.db
	dbPath := os.Getenv("DB_PATH")
	if dbPath == "" {
		cwd, _ := os.Getwd()
		dbPath = filepath.Join(cwd, "Server", "Cache", "sessions.db")
		if _, err := os.Stat(filepath.Dir(dbPath)); os.IsNotExist(err) {
			os.MkdirAll(filepath.Dir(dbPath), 0o755)
		}
	}

	// Must match the processId the server sends, or this process' locks are not released on close
	store, err := NewSessionStore(dbPath, strings.TrimSpace(os.Getenv("NZIP_PROCESS_ID")))
	if err != nil {
		logErr("Open session store: %v", err)
		os.Exit(1)
	}

	c := newCore(store, NewDownloadManager())

	signal.Ignore(syscall.SIGINT, syscall.SIGTERM)

	logInfo("nzip-core ready (db=%s)", dbPath)

	if err := c.serve(os.Stdin); err != nil {
		logErr("Stdin: %v", err)
	}

	c.shutdown()
}

// serve reads commands until stdin closes or a shutdown command arrives.
func (c *core) serve(r io.Reader) error {
	br := bufio.NewReaderSize(r, 64<<10)
	for {
		line, tooLong, err := readCommandLine(br, maxCommandBytes)
		if tooLong {
			reqID := extractReqID(line)
			logErr("Command [%s] exceeds %d bytes, rejected", reqID, maxCommandBytes)
			if reqID != "" {
				fail(reqID, fmt.Sprintf("command exceeds %d bytes", maxCommandBytes))
			}
		} else if c.handleLine(line) {
			return nil
		}

		if err != nil {
			if errors.Is(err, io.EOF) {
				logInfo("Stdin closed - exiting")
				return nil
			}
			return err
		}
	}
}

// readCommandLine reads one line, keeping at most limit bytes of it; the rest of an
// oversized line is drained so the next command still starts on a line boundary.
func readCommandLine(br *bufio.Reader, limit int) (line []byte, tooLong bool, err error) {
	for {
		chunk, err := br.ReadSlice('\n')
		if !tooLong {
			if len(line)+len(chunk) > limit {
				tooLong = true
				line = append(line, chunk[:limit-len(line)]...)
			} else {
				line = append(line, chunk...)
			}
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		return line, tooLong, err
	}
}

var reqIDPattern = regexp.MustCompile(`"reqId"\s*:\s*("(?:[^"\\]|\\.)*")`)

// extractReqID salvages the request id from a line that does not decode, so the caller gets an answer.
func extractReqID(line []byte) string {
	var probe struct {
		ReqID string `json:"reqId"`
	}
	if json.Unmarshal(line, &probe) == nil && probe.ReqID != "" {
		return probe.ReqID
	}

	m := reqIDPattern.FindSubmatch(line[:min(len(line), 4096)])
	if m == nil {
		return ""
	}
	id, err := strconv.Unquote(string(m[1]))
	if err != nil {
		return ""
	}
	return id
}

// handleLine dispatches one command line and reports whether it was a shutdown.
func (c *core) handleLine(line []byte) bool {
	line = bytes.TrimSpace(line)
	if len(line) == 0 {
		return false
	}

	var cmd Command
	if err := json.Unmarshal(line, &cmd); err != nil {
		reqID := extractReqID(line)
		logErr("Decode command [%s]: %v", reqID, err)
		if reqID != "" {
			fail(reqID, "invalid command: "+err.Error())
		}
		return false
	}

	switch {
	case cmd.Cmd == "shutdown":
		ok(cmd.ReqID, nil)
		return true
	case strings.HasPrefix(cmd.Cmd, "session."):
		c.sessionQueue <- cmd
	default:
		c.dispatch(cmd)
	}
	return false
}

// shutdown stops new work, waits a bounded time for jobs to wind down, then closes the store.
func (c *core) shutdown() {
	c.dm.StopAll()
	c.cancel()
	close(c.sessionQueue)

	deadline := time.After(shutdownGrace)
	jobsDone := make(chan struct{})
	go func() {
		c.jobs.Wait()
		close(jobsDone)
	}()
	for _, done := range []chan struct{}{jobsDone, c.sessionDone} {
		select {
		case <-done:
		case <-deadline:
			logWarn("Shutdown: jobs still running after %s, closing anyway", shutdownGrace)
			c.store.Close()
			return
		}
	}
	c.store.Close()
}

func (c *core) runSessionWorker() {
	defer close(c.sessionDone)
	for cmd := range c.sessionQueue {
		c.dispatchSession(cmd)
	}
}

func (c *core) dispatchSession(cmd Command) {
	defer func() {
		if r := recover(); r != nil {
			logErr("Panic in dispatch [%s] %s: %v", cmd.ReqID, cmd.Cmd, r)
			fail(cmd.ReqID, fmt.Sprintf("internal error: %v", r))
		}
	}()

	store := c.store
	switch cmd.Cmd {
	case "session.getOrCreate":
		s, err := store.GetOrCreate(cmd.GalleryID, cmd.Hash)
		if err != nil {
			fail(cmd.ReqID, err.Error())
		} else {
			ok(cmd.ReqID, s)
		}

	case "session.get":
		s, err := store.Get(cmd.Hash)
		if err != nil {
			fail(cmd.ReqID, err.Error())
		} else {
			ok(cmd.ReqID, s) // s may be nil → JSON null, that's fine
		}

	case "session.update":
		var patch SessionPatch
		if err := json.Unmarshal(cmd.Data, &patch); err != nil {
			fail(cmd.ReqID, "invalid data: "+err.Error())
			return
		}
		if err := store.Update(cmd.Hash, patch); err != nil {
			fail(cmd.ReqID, err.Error())
		} else {
			ok(cmd.ReqID, nil)
		}

	case "session.touch":
		if err := store.Touch(cmd.Hash); err != nil {
			fail(cmd.ReqID, err.Error())
		} else {
			ok(cmd.ReqID, nil)
		}

	case "session.delete":
		if err := store.Delete(cmd.Hash); err != nil {
			fail(cmd.ReqID, err.Error())
		} else {
			ok(cmd.ReqID, nil)
		}

	case "session.exists":
		exists, err := store.Exists(cmd.Hash)
		if err != nil {
			fail(cmd.ReqID, err.Error())
		} else {
			okValue(cmd.ReqID, exists)
		}

	case "session.getAll":
		sessions, err := store.GetAll()
		if err != nil {
			fail(cmd.ReqID, err.Error())
		} else {
			ok(cmd.ReqID, sessions)
		}

	case "session.tryAcquireLock":
		acquired, err := store.TryAcquireLock(cmd.Hash, cmd.ProcessID)
		if err != nil {
			fail(cmd.ReqID, err.Error())
		} else {
			okValue(cmd.ReqID, acquired)
		}

	case "session.refreshLock":
		refreshed, err := store.RefreshLock(cmd.Hash, cmd.ProcessID)
		if err != nil {
			fail(cmd.ReqID, err.Error())
		} else {
			okValue(cmd.ReqID, refreshed)
		}

	case "session.releaseLock":
		if err := store.ReleaseLock(cmd.Hash, cmd.ProcessID); err != nil {
			fail(cmd.ReqID, err.Error())
		} else {
			ok(cmd.ReqID, nil)
		}

	default:
		fail(cmd.ReqID, "unknown command: "+cmd.Cmd)
	}
}

// validArchiveFilename rejects anything that is not a plain file name inside downloadDir.
func validArchiveFilename(name string) error {
	if name == "" || name == "." || name == ".." || name != filepath.Base(name) || strings.ContainsAny(name, `/\`) {
		return fmt.Errorf("invalid filename %q", name)
	}
	return nil
}

func (c *core) dispatch(cmd Command) {
	defer func() {
		if r := recover(); r != nil {
			logErr("Panic in dispatch [%s] %s: %v", cmd.ReqID, cmd.Cmd, r)
			fail(cmd.ReqID, fmt.Sprintf("internal error: %v", r))
		}
	}()

	dm := c.dm
	switch cmd.Cmd {

	case "ping":
		ok(cmd.ReqID, map[string]any{"version": Version})

	// download commands
	case "download.start":
		if err := validArchiveFilename(cmd.Filename); err != nil {
			logErr("Download %s: %v", cmd.Hash, err)
			failCode(cmd.ReqID, 0x01)
			return
		}
		concurrent := cmd.ConcurrentDownloads
		if concurrent <= 0 {
			concurrent = defaultConcurrentDownloads
		}
		cfg := DownloadConfig{
			ReqID:               cmd.ReqID,
			Hash:                cmd.Hash,
			Images:              cmd.Images,
			DownloadDir:         cmd.DownloadDir,
			Filename:            cmd.Filename,
			ConcurrentDownloads: concurrent,
			Debug:               cmd.Debug,
			OnProgress: func(completed, total int) {
				send(Response{
					ReqID:     cmd.ReqID,
					Type:      "progress",
					Completed: completed,
					Total:     total,
				})
			},
			OnPackStart: func() {
				send(Response{ReqID: cmd.ReqID, Type: "packStart"})
			},
		}
		// Run in a separate goroutine so the dispatcher stays unblocked.
		c.runAsyncCommand(cmd.ReqID, cmd.Cmd, func() {
			result := dm.Run(c.ctx, cfg)
			if result.Success {
				ok(cmd.ReqID, map[string]any{"success": true, "missingPages": result.MissingPages})
			} else {
				failCode(cmd.ReqID, result.ErrorCode)
			}
		})

	case "download.stop":
		dm.Stop(cmd.Hash)
		ok(cmd.ReqID, nil)

	case "download.stopAll":
		dm.StopAll()
		ok(cmd.ReqID, nil)

	case "download.hasActive":
		okValue(cmd.ReqID, dm.HasActive(cmd.Hash))

	case "download.cleanTempFiles":
		c.runAsyncCommand(cmd.ReqID, cmd.Cmd, func() {
			CleanTempFiles(cmd.DownloadDir, cmd.Filename)
			ok(cmd.ReqID, nil)
		})

	case "download.packFormat":
		if err := validArchiveFilename(cmd.Filename); err != nil {
			fail(cmd.ReqID, err.Error())
			return
		}
		c.runAsyncCommand(cmd.ReqID, cmd.Cmd, func() {
			ctx, cancel := context.WithTimeout(c.ctx, packFormatTimeout)
			defer cancel()

			if err := packArchiveFormat(ctx, DownloadConfig{
				Hash:        cmd.Hash,
				Images:      cmd.Images,
				DownloadDir: cmd.DownloadDir,
				Filename:    cmd.Filename,
			}, cmd.Format); err != nil {
				fail(cmd.ReqID, err.Error())
			} else {
				ok(cmd.ReqID, nil)
			}
		})

	case "download.extractArchive":
		if err := validArchiveFilename(cmd.Filename); err != nil {
			fail(cmd.ReqID, err.Error())
			return
		}
		c.runAsyncCommand(cmd.ReqID, cmd.Cmd, func() {
			if err := extractArchiveImages(filepath.Join(cmd.DownloadDir, cmd.Filename), cmd.DownloadDir); err != nil {
				fail(cmd.ReqID, err.Error())
			} else {
				ok(cmd.ReqID, nil)
			}
		})

	default:
		fail(cmd.ReqID, "unknown command: "+cmd.Cmd)
	}
}

func (c *core) runAsyncCommand(reqID, cmdName string, fn func()) {
	c.jobs.Go(func() {
		defer func() {
			if r := recover(); r != nil {
				logErr("Panic in async dispatch [%s] %s: %v", reqID, cmdName, r)
				fail(reqID, fmt.Sprintf("internal error: %v", r))
			}
		}()

		fn()
	})
}
