package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/binary"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/phpdave11/gofpdf"
)

func TestBuildArchiveFileContention(t *testing.T) {
	out := filepath.Join(t.TempDir(), "gallery.zip")
	var builds atomic.Int32

	var wg sync.WaitGroup
	errs := make([]error, 4)
	for i := range errs {
		wg.Go(func() {
			errs[i] = buildArchiveFile(context.Background(), out, packSlots, func(f *os.File) error {
				builds.Add(1)
				time.Sleep(150 * time.Millisecond)
				_, err := f.WriteString("archive")
				return err
			})
		})
	}
	wg.Wait()

	for _, err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if n := builds.Load(); n != 1 {
		t.Fatalf("built %d times", n)
	}
	if data, _ := os.ReadFile(out); string(data) != "archive" {
		t.Fatalf("archive = %q", data)
	}
	entries, _ := os.ReadDir(filepath.Dir(out))
	for _, e := range entries {
		if e.Name() != "gallery.zip" {
			t.Fatalf("left behind %s", e.Name())
		}
	}
}

func TestBuildArchiveFileFailureKeepsNothing(t *testing.T) {
	out := filepath.Join(t.TempDir(), "gallery.cbz")
	err := buildArchiveFile(context.Background(), out, nil, func(f *os.File) error {
		f.WriteString("partial")
		return os.ErrInvalid
	})
	if err == nil {
		t.Fatal("expected error")
	}
	entries, _ := os.ReadDir(filepath.Dir(out))
	if len(entries) != 0 {
		t.Fatalf("left behind %v", entries)
	}
}

func TestBuildArchiveFileLockWaitCancels(t *testing.T) {
	out := filepath.Join(t.TempDir(), "gallery.pdf")
	release, err := tryArchiveLock(archiveLockPath(out))
	if err != nil || release == nil {
		t.Fatalf("lock: %v", err)
	}
	defer release()

	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	err = buildArchiveFile(ctx, out, nil, func(*os.File) error {
		t.Fatal("built while another holder had the lock")
		return nil
	})
	if err == nil {
		t.Fatal("expected the wait to be cancelled")
	}
}

func writeTestZip(t *testing.T, path string, entries map[string][]byte) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(f)
	names := make([]string, 0, len(entries))
	for name := range entries {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		w, err := zw.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Store})
		if err != nil {
			t.Fatal(err)
		}
		w.Write(entries[name])
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	f.Close()
}

func TestExtractArchiveImagesRejectsEscapes(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "gallery")
	os.Mkdir(dir, 0o755)
	archive := filepath.Join(dir, "g.zip")
	img := testPNG(t, 2, 2)
	writeTestZip(t, archive, map[string][]byte{
		"../evil.jpg":  img,
		"/abs.jpg":     img,
		"sub/deep.jpg": img,
		"1.png":        img,
		"notes.txt":    []byte("x"),
	})

	if err := extractArchiveImages(archive, dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "evil.jpg")); !os.IsNotExist(err) {
		t.Fatal("zip-slip entry escaped")
	}
	var got []string
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		got = append(got, e.Name())
	}
	if !slices.Equal(got, []string{"1.png", "g.zip"}) {
		t.Fatalf("extracted %v", got)
	}
}

func TestExtractArchiveImagesSizeLimit(t *testing.T) {
	limit := maxImageBytes
	maxImageBytes = 100
	t.Cleanup(func() { maxImageBytes = limit })

	dir := t.TempDir()
	archive := filepath.Join(dir, "g.zip")
	writeTestZip(t, archive, map[string][]byte{"1.jpg": bytes.Repeat([]byte{1}, 101)})

	if err := extractArchiveImages(archive, dir); err == nil || !strings.Contains(err.Error(), "limit") {
		t.Fatalf("err = %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "1.jpg")); !os.IsNotExist(err) {
		t.Fatal("oversized entry written")
	}
}

func TestCollectExistingImageFilesReportsSkipped(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "1.jpg"), []byte("x"), 0o644)
	os.WriteFile(filepath.Join(dir, "2.jpg"), nil, 0o644)
	cfg := DownloadConfig{Hash: "h", DownloadDir: dir, Images: []string{"http://h/a/1.jpg", "http://h/a/2.jpg", "http://h/a/3.jpg"}}

	paths, skipped, err := collectExistingImageFiles(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) != 1 || !slices.Equal(skipped, []int{2, 3}) {
		t.Fatalf("paths %v skipped %v", paths, skipped)
	}
}

func TestPNGNeedsPDFReencode(t *testing.T) {
	ihdr := func(depth, colorType, interlace byte) []byte {
		b := []byte(pngSignature)
		b = binary.BigEndian.AppendUint32(b, 13)
		b = append(b, "IHDR"...)
		b = binary.BigEndian.AppendUint32(b, 10)
		b = binary.BigEndian.AppendUint32(b, 10)
		b = append(b, depth, colorType, 0, 0, interlace)
		return append(b, 0, 0, 0, 0)
	}
	cases := []struct {
		data []byte
		want bool
	}{
		{ihdr(8, 2, 0), false},
		{ihdr(8, 6, 0), false},
		{ihdr(1, 3, 0), false},
		{ihdr(16, 2, 0), true},
		{ihdr(8, 2, 1), true},
		{ihdr(8, 5, 0), true},
		{[]byte("not a png"), true},
		{testPNG(t, 3, 3), false},
	}
	for i, c := range cases {
		if got := pngNeedsPDFReencode(c.data); got != c.want {
			t.Errorf("case %d: got %v, want %v", i, got, c.want)
		}
	}
}

func TestCBZEntryNamer(t *testing.T) {
	name := cbzEntryNamer([]string{"/d/1.jpg", "/d/2.png", "/d/120.jpg", "/d/cover.jpg"})
	cases := map[string]string{
		"/d/1.jpg":     "001.jpg",
		"/d/2.png":     "002.png",
		"/d/120.jpg":   "120.jpg",
		"/d/cover.jpg": "cover.jpg",
	}
	for in, want := range cases {
		if got := name(in); got != want {
			t.Errorf("%s -> %s, want %s", in, got, want)
		}
	}
	if got := cbzEntryNamer([]string{"/d/a.jpg"})("/d/a.jpg"); got != "a.jpg" {
		t.Errorf("non-numeric -> %s", got)
	}
}

func TestCompareArchiveImageNames(t *testing.T) {
	names := []string{"10.jpg", "2.jpg", "1.png", "b.jpg", "1.jpg", "a.jpg"}
	sort.Slice(names, func(i, j int) bool { return compareArchiveImageNames(names[i], names[j]) < 0 })
	want := []string{"1.jpg", "1.png", "2.jpg", "10.jpg", "a.jpg", "b.jpg"}
	if !slices.Equal(names, want) {
		t.Fatalf("sorted %v, want %v", names, want)
	}
}

func TestEPUBMimetypeEntry(t *testing.T) {
	dir := t.TempDir()
	page := filepath.Join(dir, "1.png")
	os.WriteFile(page, testPNG(t, 2, 2), 0o644)
	out := filepath.Join(dir, "g.epub")
	if err := packEPUB(context.Background(), []string{page}, out, "T & <T>", "h"); err != nil {
		t.Fatal(err)
	}

	raw, _ := os.ReadFile(out)
	// Local header: name at offset 30, no extra field, data right after.
	if !bytes.HasPrefix(raw[30:], []byte("mimetypeapplication/epub+zip")) {
		t.Fatalf("mimetype entry not first/stored/plain: %q", raw[:64])
	}
	if flags := binary.LittleEndian.Uint16(raw[6:]); flags&0x8 != 0 {
		t.Fatal("mimetype entry uses a data descriptor")
	}
	if extra := binary.LittleEndian.Uint16(raw[28:]); extra != 0 {
		t.Fatalf("mimetype entry has a %d byte extra field", extra)
	}

	zr, err := zip.OpenReader(out)
	if err != nil {
		t.Fatal(err)
	}
	defer zr.Close()
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		if _, err := bytes.NewBuffer(nil).ReadFrom(rc); err != nil {
			t.Fatalf("%s: %v", f.Name, err)
		}
		rc.Close()
	}
}

func TestPDFPageSizeCap(t *testing.T) {
	size := pdfPageSize(800, 28800)
	if size.Ht != maxPDFPageSide || size.Wd != 400 {
		t.Fatalf("size = %+v", size)
	}
	if size := pdfPageSize(1200, 1800); size.Wd != 1200 || size.Ht != 1800 {
		t.Fatalf("small page scaled: %+v", size)
	}

	dir := t.TempDir()
	tall := filepath.Join(dir, "1.png")
	os.WriteFile(tall, testPNG(t, 20, 20000), 0o644)
	pdf := gofpdf.NewCustom(&gofpdf.InitType{UnitStr: "pt"})
	if err := addPDFPage(pdf, 0, tall); err != nil {
		t.Fatal(err)
	}
	if w, h := pdf.GetPageSize(); h > maxPDFPageSide || w <= 0 {
		t.Fatalf("page %vx%v", w, h)
	}
	if err := pdf.Output(&bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
}
