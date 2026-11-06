package main

import (
	"fmt"
	"path/filepath"
	"sync"
	"testing"
)

func TestSessionStoreConcurrentGetOrCreateAcrossHandles(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "sessions.db")
	a, err := NewSessionStore(dbPath, "a")
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	b, err := NewSessionStore(dbPath, "b")
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()

	for round := range 20 {
		hash := fmt.Sprintf("hash-%d", round)
		var wg sync.WaitGroup
		results := make([]*SharedSessionData, 8)
		errs := make([]error, 8)
		for i := range results {
			store := a
			if i%2 == 1 {
				store = b
			}
			wg.Go(func() {
				results[i], errs[i] = store.GetOrCreate("gallery", hash)
			})
		}
		wg.Wait()

		for i, err := range errs {
			if err != nil {
				t.Fatalf("round %d caller %d: %v", round, i, err)
			}
			if results[i].Hash != hash || results[i].ID != "gallery" || results[i].CreatedAt != results[0].CreatedAt {
				t.Fatalf("round %d caller %d got %+v", round, i, results[i])
			}
		}
	}

	all, err := a.GetAll()
	if err != nil || len(all) != 20 {
		t.Fatalf("GetAll = %d sessions, %v", len(all), err)
	}
}

func TestSessionStoreGetOrCreateKeepsExistingState(t *testing.T) {
	s, err := NewSessionStore(filepath.Join(t.TempDir(), "sessions.db"), "")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	if _, err := s.GetOrCreate("g", "h"); err != nil {
		t.Fatal(err)
	}
	done := true
	if err := s.Update("h", SessionPatch{DownloadCompleted: &done}); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetOrCreate("other", "h")
	if err != nil {
		t.Fatal(err)
	}
	if !got.DownloadCompleted || got.ID != "g" {
		t.Fatalf("existing session overwritten: %+v", got)
	}
	if missing, err := s.Get("nope"); err != nil || missing != nil {
		t.Fatalf("Get(nope) = %+v, %v", missing, err)
	}
}

func TestSessionStorePragmasOnEveryConnection(t *testing.T) {
	s, err := NewSessionStore(filepath.Join(t.TempDir(), "sessions.db"), "")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	var mode string
	var timeout int
	if err := s.db.QueryRow("PRAGMA journal_mode").Scan(&mode); err != nil || mode != "wal" {
		t.Fatalf("journal_mode = %q, %v", mode, err)
	}
	if err := s.db.QueryRow("PRAGMA busy_timeout").Scan(&timeout); err != nil || timeout != 5000 {
		t.Fatalf("busy_timeout = %d, %v", timeout, err)
	}
}
