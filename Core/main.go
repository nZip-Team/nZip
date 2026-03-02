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
//	shutdown
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
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

	store, err := NewSessionStore(dbPath)
	if err != nil {
		logErr("Open session store: %v", err)
		os.Exit(1)
	}
	defer store.Close()

	dm := NewDownloadManager()

	signal.Ignore(syscall.SIGINT, syscall.SIGTERM)

	logInfo("nzip-core ready (db=%s)", dbPath)

	scanner := bufio.NewScanner(os.Stdin)
	// Enlarge the buffer to handle large image-URL arrays.
	scanner.Buffer(make([]byte, 4*1024*1024), 4*1024*1024)

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		var cmd Command
		if err := json.Unmarshal(line, &cmd); err != nil {
			logErr("Decode command: %v", err)
			continue
		}

		dispatch(store, dm, cmd)
	}

	if err := scanner.Err(); err != nil {
		logErr("Stdin scanner: %v", err)
	} else {
		logInfo("Stdin closed - exiting")
	}

	// stdin closed → graceful exit
	dm.StopAll()
	store.Close()
}

func dispatch(store *SessionStore, dm *DownloadManager, cmd Command) {
	defer func() {
		if r := recover(); r != nil {
			logErr("Panic in dispatch [%s] %s: %v", cmd.ReqID, cmd.Cmd, r)
			fail(cmd.ReqID, fmt.Sprintf("internal error: %v", r))
		}
	}()

	switch cmd.Cmd {

	// session commands
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

	// download commands
	case "download.start":
		concurrent := cmd.ConcurrentDownloads
		if concurrent <= 0 {
			concurrent = 3
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
		go func() {
			result := dm.Run(cfg)
			if result.Success {
				ok(cmd.ReqID, map[string]bool{"success": true})
			} else {
				failCode(cmd.ReqID, result.ErrorCode)
			}
		}()

	case "download.stop":
		dm.Stop(cmd.Hash)
		ok(cmd.ReqID, nil)

	case "download.stopAll":
		dm.StopAll()
		ok(cmd.ReqID, nil)

	case "download.hasActive":
		okValue(cmd.ReqID, dm.HasActive(cmd.Hash))

	case "download.cleanTempFiles":
		CleanTempFiles(cmd.DownloadDir, cmd.Filename)
		ok(cmd.ReqID, nil)

	// system commands
	case "shutdown":
		ok(cmd.ReqID, nil)
		dm.StopAll()
		store.Close()
		os.Exit(0)

	default:
		fail(cmd.ReqID, "unknown command: "+cmd.Cmd)
	}
}
