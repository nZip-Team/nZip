package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// SharedSessionData mirrors the TypeScript SharedSessionData interface.
type SharedSessionData struct {
	ID                 string  `json:"id"`
	Hash               string  `json:"hash"`
	DownloadCompleted  bool    `json:"downloadCompleted"`
	IsDownloading      bool    `json:"isDownloading"`
	DownloadingBy      *string `json:"downloadingBy"`
	Filename           *string `json:"filename"`
	DownloadLink       *string `json:"downloadLink"`
	LastDownloadStatus *string `json:"lastDownloadStatus"`
	LastPackStatus     *string `json:"lastPackStatus"`
	LastLinkStatus     *string `json:"lastLinkStatus"`
	IsAborting         bool    `json:"isAborting"`
	CreatedAt          int64   `json:"createdAt"`
	LastActivityAt     int64   `json:"lastActivityAt"`
}

// SessionPatch holds the optional fields that can be updated.
type SessionPatch struct {
	DownloadCompleted  *bool               `json:"downloadCompleted"`
	IsDownloading      *bool               `json:"isDownloading"`
	DownloadingBy      NullableStringPatch `json:"downloadingBy"`
	Filename           NullableStringPatch `json:"filename"`
	DownloadLink       NullableStringPatch `json:"downloadLink"`
	LastDownloadStatus NullableStringPatch `json:"lastDownloadStatus"`
	LastPackStatus     NullableStringPatch `json:"lastPackStatus"`
	LastLinkStatus     NullableStringPatch `json:"lastLinkStatus"`
	IsAborting         *bool               `json:"isAborting"`
}

// NullableStringPatch tracks whether a nullable string field was provided,
// and whether it was set to a concrete string or explicit null.
type NullableStringPatch struct {
	Set   bool
	Value *string
}

func (p *NullableStringPatch) UnmarshalJSON(data []byte) error {
	p.Set = true
	if string(data) == "null" {
		p.Value = nil
		return nil
	}

	var v string
	if err := json.Unmarshal(data, &v); err != nil {
		return err
	}
	p.Value = &v
	return nil
}

// SessionStore is a SQLite-backed, thread-safe session store.
type SessionStore struct {
	db          *sql.DB
	mu          sync.Mutex // serialises writes; reads use their own short lock windows
	cleanupStop chan struct{}
	cleanupDone chan struct{}
	closeOnce   sync.Once
}

const schema = `
CREATE TABLE IF NOT EXISTS sessions (
    hash                TEXT PRIMARY KEY,
    id                  TEXT NOT NULL,
    downloadCompleted   INTEGER NOT NULL DEFAULT 0,
    isDownloading       INTEGER NOT NULL DEFAULT 0,
    downloadingBy       TEXT,
    filename            TEXT,
    downloadLink        TEXT,
    lastDownloadStatus  TEXT,
    lastPackStatus      TEXT,
    lastLinkStatus      TEXT,
    isAborting          INTEGER NOT NULL DEFAULT 0,
    createdAt           INTEGER NOT NULL,
    lastActivityAt      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lastActivityAt ON sessions(lastActivityAt);
`

// NewSessionStore opens (or creates) the SQLite database at dbPath.
func NewSessionStore(dbPath string) (*SessionStore, error) {
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("open db: %w", err)
	}
	db.SetMaxOpenConns(1) // SQLite is single-writer; avoid BUSY errors

	if _, err = db.Exec("PRAGMA journal_mode=WAL"); err != nil {
		return nil, fmt.Errorf("set WAL: %w", err)
	}
	if _, err = db.Exec("PRAGMA synchronous=NORMAL"); err != nil {
		return nil, fmt.Errorf("set synchronous: %w", err)
	}
	if _, err = db.Exec("PRAGMA busy_timeout=5000"); err != nil {
		return nil, fmt.Errorf("set busy_timeout: %w", err)
	}
	if _, err = db.Exec(schema); err != nil {
		return nil, fmt.Errorf("apply schema: %w", err)
	}

	s := &SessionStore{
		db:          db,
		cleanupStop: make(chan struct{}),
		cleanupDone: make(chan struct{}),
	}

	_, _ = db.Exec(`UPDATE sessions SET isDownloading=0, downloadingBy=NULL WHERE isDownloading=1`)
	_, _ = db.Exec(`UPDATE sessions SET isAborting=0 WHERE isAborting=1 AND downloadCompleted=0`)

	// Start periodic cleanup (mirrors TypeScript implementation).
	go s.startCleanupJob()

	return s, nil
}

// Close shuts down the session store.
func (s *SessionStore) Close() {
	s.closeOnce.Do(func() {
		close(s.cleanupStop)
		<-s.cleanupDone

		s.mu.Lock()
		defer s.mu.Unlock()
		// Release all active locks before close.
		_, _ = s.db.Exec(`UPDATE sessions SET isDownloading=0, downloadingBy=NULL WHERE isDownloading=1`)
		_ = s.db.Close()
	})
}

// GetOrCreate returns an existing session for hash, or creates a new one.
func (s *SessionStore) GetOrCreate(id, hash string) (*SharedSessionData, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	existing, err := s.get(hash)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		if err := s.touch(hash); err != nil {
			return nil, err
		}
		return existing, nil
	}

	now := time.Now().UnixMilli()
	_, err = s.db.Exec(
		`INSERT INTO sessions (hash,id,downloadCompleted,isDownloading,isAborting,createdAt,lastActivityAt)
		 VALUES (?,?,0,0,0,?,?)`,
		hash, id, now, now,
	)
	if err != nil {
		return nil, fmt.Errorf("insert session: %w", err)
	}

	return &SharedSessionData{
		ID:             id,
		Hash:           hash,
		CreatedAt:      now,
		LastActivityAt: now,
	}, nil
}

// Get returns the session for hash, or nil if not found.
func (s *SessionStore) Get(hash string) (*SharedSessionData, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.get(hash)
}

// get is the internal (already-locked) variant.
func (s *SessionStore) get(hash string) (*SharedSessionData, error) {
	row := s.db.QueryRow(`SELECT
		hash,id,downloadCompleted,isDownloading,downloadingBy,
		filename,downloadLink,lastDownloadStatus,lastPackStatus,lastLinkStatus,
		isAborting,createdAt,lastActivityAt
	FROM sessions WHERE hash=?`, hash)

	var sd SharedSessionData
	var dlCompleted, isDownloading, isAborting int
	err := row.Scan(
		&sd.Hash, &sd.ID, &dlCompleted, &isDownloading, &sd.DownloadingBy,
		&sd.Filename, &sd.DownloadLink, &sd.LastDownloadStatus, &sd.LastPackStatus, &sd.LastLinkStatus,
		&isAborting, &sd.CreatedAt, &sd.LastActivityAt,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get session: %w", err)
	}
	sd.DownloadCompleted = dlCompleted != 0
	sd.IsDownloading = isDownloading != 0
	sd.IsAborting = isAborting != 0
	return &sd, nil
}

// Update applies a partial patch to a session.
func (s *SessionStore) Update(hash string, patch SessionPatch) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	cols := []string{}
	vals := []any{}

	if patch.DownloadCompleted != nil {
		cols = append(cols, "downloadCompleted=?")
		vals = append(vals, boolToInt(*patch.DownloadCompleted))
	}
	if patch.IsDownloading != nil {
		cols = append(cols, "isDownloading=?")
		vals = append(vals, boolToInt(*patch.IsDownloading))
	}
	if patch.DownloadingBy.Set {
		cols = append(cols, "downloadingBy=?")
		vals = append(vals, patch.DownloadingBy.Value)
	}
	if patch.Filename.Set {
		cols = append(cols, "filename=?")
		vals = append(vals, patch.Filename.Value)
	}
	if patch.DownloadLink.Set {
		cols = append(cols, "downloadLink=?")
		vals = append(vals, patch.DownloadLink.Value)
	}
	if patch.LastDownloadStatus.Set {
		cols = append(cols, "lastDownloadStatus=?")
		vals = append(vals, patch.LastDownloadStatus.Value)
	}
	if patch.LastPackStatus.Set {
		cols = append(cols, "lastPackStatus=?")
		vals = append(vals, patch.LastPackStatus.Value)
	}
	if patch.LastLinkStatus.Set {
		cols = append(cols, "lastLinkStatus=?")
		vals = append(vals, patch.LastLinkStatus.Value)
	}
	if patch.IsAborting != nil {
		cols = append(cols, "isAborting=?")
		vals = append(vals, boolToInt(*patch.IsAborting))
	}

	if len(cols) == 0 {
		return nil
	}

	q := "UPDATE sessions SET " + strings.Join(cols, ",") + ",lastActivityAt=? WHERE hash=?"
	vals = append(vals, time.Now().UnixMilli(), hash)

	_, err := s.db.Exec(q, vals...)
	return err
}

// Touch updates lastActivityAt for hash.
func (s *SessionStore) Touch(hash string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.touch(hash)
}

func (s *SessionStore) touch(hash string) error {
	_, err := s.db.Exec(
		`UPDATE sessions SET lastActivityAt=? WHERE hash=?`,
		time.Now().UnixMilli(), hash,
	)
	return err
}

// Delete removes the session with hash.
func (s *SessionStore) Delete(hash string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`DELETE FROM sessions WHERE hash=?`, hash)
	return err
}

// Exists reports whether a session with hash is stored.
func (s *SessionStore) Exists(hash string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	row := s.db.QueryRow(`SELECT 1 FROM sessions WHERE hash=?`, hash)
	var v int
	err := row.Scan(&v)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return err == nil, err
}

// GetAll returns every stored session.
func (s *SessionStore) GetAll() ([]SharedSessionData, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	rows, err := s.db.Query(`SELECT
		hash,id,downloadCompleted,isDownloading,downloadingBy,
		filename,downloadLink,lastDownloadStatus,lastPackStatus,lastLinkStatus,
		isAborting,createdAt,lastActivityAt
	FROM sessions`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var sessions []SharedSessionData
	for rows.Next() {
		var sd SharedSessionData
		var dlCompleted, isDownloading, isAborting int
		if err := rows.Scan(
			&sd.Hash, &sd.ID, &dlCompleted, &isDownloading, &sd.DownloadingBy,
			&sd.Filename, &sd.DownloadLink, &sd.LastDownloadStatus, &sd.LastPackStatus, &sd.LastLinkStatus,
			&isAborting, &sd.CreatedAt, &sd.LastActivityAt,
		); err != nil {
			return nil, err
		}
		sd.DownloadCompleted = dlCompleted != 0
		sd.IsDownloading = isDownloading != 0
		sd.IsAborting = isAborting != 0
		sessions = append(sessions, sd)
	}
	return sessions, rows.Err()
}

// TryAcquireLock tries to mark a session as downloading by processID.
// Returns true only when the lock was successfully acquired.
func (s *SessionStore) TryAcquireLock(hash, processID string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	staleCutoff := time.Now().Add(-5 * time.Minute).UnixMilli()
	res, err := s.db.Exec(
		`UPDATE sessions
		 SET isDownloading=1, downloadingBy=?, lastActivityAt=?, isAborting=0
		 WHERE hash=? AND downloadCompleted=0
		   AND (isDownloading=0 OR lastActivityAt<?)`,
		processID, time.Now().UnixMilli(), hash, staleCutoff,
	)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// RefreshLock extends the lock TTL by bumping lastActivityAt.
func (s *SessionStore) RefreshLock(hash, processID string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	res, err := s.db.Exec(
		`UPDATE sessions SET lastActivityAt=?
		 WHERE hash=? AND downloadingBy=? AND isDownloading=1`,
		time.Now().UnixMilli(), hash, processID,
	)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// ReleaseLock clears the downloading flag for a session owned by processID.
func (s *SessionStore) ReleaseLock(hash, processID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(
		`UPDATE sessions SET isDownloading=0, downloadingBy=NULL
		 WHERE hash=? AND downloadingBy=?`,
		hash, processID,
	)
	return err
}

// startCleanupJob periodically deletes sessions older than 5 minutes at :00s.
func (s *SessionStore) startCleanupJob() {
	defer close(s.cleanupDone)

	runCleanup := func() {
		cutoff := time.Now().Add(-5 * time.Minute).UnixMilli()
		s.mu.Lock()
		res, err := s.db.Exec(`DELETE FROM sessions WHERE lastActivityAt<?`, cutoff)
		s.mu.Unlock()
		if err != nil {
			logWarn("Session cleanup: %v", err)
			return
		}
		if n, _ := res.RowsAffected(); n > 0 {
			logInfo("Session cleanup: removed %d expired session(s)", n)
		}
	}

	for {
		nextRun := time.Now().Truncate(time.Minute).Add(time.Minute)
		timer := time.NewTimer(time.Until(nextRun))

		select {
		case <-s.cleanupStop:
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			return
		case <-timer.C:
			runCleanup()
		}
	}
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
