package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

// captureResponses redirects protocol output for the test and returns a reader for it.
func captureResponses(t *testing.T) func() map[string]Response {
	t.Helper()
	var buf bytes.Buffer
	stdoutMu.Lock()
	prev := stdoutEnc
	stdoutEnc = json.NewEncoder(&buf)
	stdoutMu.Unlock()
	t.Cleanup(func() {
		stdoutMu.Lock()
		stdoutEnc = prev
		stdoutMu.Unlock()
	})

	return func() map[string]Response {
		stdoutMu.Lock()
		defer stdoutMu.Unlock()
		out := map[string]Response{}
		sc := bufio.NewScanner(bytes.NewReader(buf.Bytes()))
		for sc.Scan() {
			var r Response
			if err := json.Unmarshal(sc.Bytes(), &r); err != nil {
				t.Fatalf("bad response line %q: %v", sc.Text(), err)
			}
			if r.Type == "result" {
				if _, dup := out[r.ReqID]; dup {
					t.Fatalf("two results for %s", r.ReqID)
				}
				out[r.ReqID] = r
			}
		}
		return out
	}
}

func TestServeDispatch(t *testing.T) {
	responses := captureResponses(t)
	store, err := NewSessionStore(filepath.Join(t.TempDir(), "sessions.db"), "")
	if err != nil {
		t.Fatal(err)
	}
	c := newCore(store, NewDownloadManager())

	huge := `{"reqId":"big","cmd":"download.start","images":["` + strings.Repeat("x", maxCommandBytes) + `"]}`
	input := strings.Join([]string{
		`{"reqId":"p1","cmd":"ping"}`,
		`{"reqId":"bad1","cmd":`,
		`{"reqId":"bad2","cmd":"download.start","images":5}`,
		`not json at all`,
		``,
		huge,
		`{"reqId":"s1","cmd":"session.getOrCreate","hash":"h","galleryId":"1"}`,
		`{"reqId":"s2","cmd":"session.exists","hash":"h"}`,
		`{"reqId":"f1","cmd":"download.packFormat","filename":"../x.zip","downloadDir":"/tmp","format":"zip"}`,
		`{"reqId":"u1","cmd":"nope"}`,
		`{"reqId":"p2","cmd":"ping"}`,
		`{"reqId":"bye","cmd":"shutdown"}`,
		`{"reqId":"after","cmd":"ping"}`,
	}, "\n") + "\n"

	if err := c.serve(strings.NewReader(input)); err != nil {
		t.Fatal(err)
	}
	c.shutdown()

	got := responses()
	for _, id := range []string{"p1", "p2", "s1", "s2", "bye"} {
		if r, ok := got[id]; !ok || r.OK == nil || !*r.OK {
			t.Errorf("%s: want success, got %+v", id, r)
		}
	}
	for _, id := range []string{"bad1", "bad2", "big", "f1", "u1"} {
		if r, ok := got[id]; !ok || r.OK == nil || *r.OK {
			t.Errorf("%s: want failure, got %+v", id, r)
		}
	}
	if !strings.Contains(got["big"].Error, "exceeds") {
		t.Errorf("big: %q", got["big"].Error)
	}
	if v, _ := got["s2"].Value.(bool); !v {
		t.Errorf("s2: session not visible after getOrCreate (order lost?)")
	}
	if _, ok := got["after"]; ok {
		t.Error("command after shutdown was dispatched")
	}
}

func TestExtractReqID(t *testing.T) {
	cases := map[string]string{
		`{"reqId":"r1","cmd":`:               "r1",
		`{"reqId":"r\"2","images":[1}`:       `r"2`,
		`{"cmd":"x"}`:                        "",
		`{"reqId":"r3","images":"notarray"}`: "r3",
		`garbage`:                            "",
	}
	for in, want := range cases {
		if got := extractReqID([]byte(in)); got != want {
			t.Errorf("extractReqID(%s) = %q, want %q", in, got, want)
		}
	}
}

func TestReadCommandLineOversized(t *testing.T) {
	br := bufio.NewReaderSize(strings.NewReader(strings.Repeat("a", 200)+"\nnext\n"), 16)
	line, tooLong, err := readCommandLine(br, 50)
	if !tooLong || len(line) != 50 || err != nil {
		t.Fatalf("line %d tooLong %v err %v", len(line), tooLong, err)
	}
	line, tooLong, err = readCommandLine(br, 50)
	if tooLong || string(line) != "next\n" || err != nil {
		t.Fatalf("next line %q tooLong %v err %v", line, tooLong, err)
	}
}
