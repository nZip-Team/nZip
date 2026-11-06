package main

import (
	"archive/zip"
	"context"
	"fmt"
	"hash/crc32"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

func packZipLike(ctx context.Context, filePaths []string, outputPath string, slots chan struct{}, entryName func(src string) string) error {
	return buildArchiveFile(ctx, outputPath, slots, func(f *os.File) error {
		zw := zip.NewWriter(f)

		for _, src := range filePaths {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			name := filepath.Base(src)
			if entryName != nil {
				name = entryName(src)
			}
			if err := addFileToZip(zw, src, name); err != nil {
				return fmt.Errorf("add %s: %w", src, err)
			}
		}

		if err := zw.Close(); err != nil {
			return fmt.Errorf("close zip writer: %w", err)
		}
		return nil
	})
}

func cbzEntryNamer(filePaths []string) func(src string) string {
	width := 0
	for _, src := range filePaths {
		stem := strings.TrimSuffix(filepath.Base(src), filepath.Ext(src))
		n, err := strconv.Atoi(stem)
		if err != nil || n < 0 {
			continue
		}
		width = max(width, len(strconv.Itoa(n)))
	}

	if width == 0 {
		return filepath.Base
	}

	return func(src string) string {
		base := filepath.Base(src)
		ext := filepath.Ext(base)
		stem := strings.TrimSuffix(base, ext)
		n, err := strconv.Atoi(stem)
		if err != nil || n < 0 {
			return base
		}
		return fmt.Sprintf("%0*d%s", width, n, ext)
	}
}

func addStringToZip(zw *zip.Writer, entryName, content string, method uint16) error {
	h := &zip.FileHeader{
		Name:   entryName,
		Method: method,
	}
	w, err := zw.CreateHeader(h)
	if err != nil {
		return err
	}
	_, err = io.WriteString(w, content)
	return err
}

// addRawStoredStringToZip writes a stored entry with its sizes in the local header and no data
// descriptor or extra field, as the EPUB mimetype entry must be.
func addRawStoredStringToZip(zw *zip.Writer, entryName, content string) error {
	size := uint64(len(content))
	w, err := zw.CreateRaw(&zip.FileHeader{
		Name:               entryName,
		Method:             zip.Store,
		CRC32:              crc32.ChecksumIEEE([]byte(content)),
		CompressedSize64:   size,
		UncompressedSize64: size,
	})
	if err != nil {
		return err
	}
	_, err = io.WriteString(w, content)
	return err
}

// addFileToZip streams src into the given ZipWriter under entryName.
func addFileToZip(zw *zip.Writer, src string, entryName string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	st, err := in.Stat()
	if err != nil {
		return err
	}

	h, err := zip.FileInfoHeader(st)
	if err != nil {
		return err
	}
	h.Name = entryName
	h.Method = zip.Store

	w, err := zw.CreateHeader(h)
	if err != nil {
		return err
	}

	_, err = io.Copy(w, in)
	return err
}

// extractArchiveImages unpacks a stored zip's images, so other formats can be packed from it.
func extractArchiveImages(archivePath, dir string) error {
	zr, err := zip.OpenReader(archivePath)
	if err != nil {
		return fmt.Errorf("open archive: %w", err)
	}
	defer zr.Close()

	extracted := 0
	for _, entry := range zr.File {
		name := filepath.Base(entry.Name)
		if entry.FileInfo().IsDir() || name != entry.Name || strings.ContainsAny(name, `/\`) || !isDownloadImageFile(name) {
			continue
		}

		dest := filepath.Join(dir, name)
		if st, err := os.Stat(dest); err == nil && st.Size() > 0 {
			extracted++
			continue
		}

		if err := extractZipEntry(entry, dest); err != nil {
			return fmt.Errorf("extract %s: %w", name, err)
		}
		extracted++
	}

	if extracted == 0 {
		return fmt.Errorf("no images in %s", filepath.Base(archivePath))
	}

	logInfo("Extract archive: %d image(s) from %s", extracted, filepath.Base(archivePath))
	return nil
}

func extractZipEntry(entry *zip.File, dest string) error {
	if entry.UncompressedSize64 > uint64(maxImageBytes) {
		return fmt.Errorf("entry is %d bytes, over the %d byte limit", entry.UncompressedSize64, maxImageBytes)
	}

	in, err := entry.Open()
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := createTemp(filepath.Dir(dest), "."+filepath.Base(dest)+".*.tmp")
	if err != nil {
		return err
	}
	tmp := out.Name()
	committed := false
	defer func() {
		if !committed {
			_ = out.Close()
			_ = os.Remove(tmp)
		}
	}()

	// The header size can lie; the reader cap cannot.
	written, err := io.Copy(out, io.LimitReader(in, maxImageBytes+1))
	if err != nil {
		return err
	}
	if written > maxImageBytes {
		return fmt.Errorf("entry exceeds the %d byte limit", maxImageBytes)
	}
	if err := out.Sync(); err != nil {
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, dest); err != nil {
		return err
	}
	committed = true
	return nil
}

// os.CreateTemp makes 0600 files, which a replica running as another user cannot read
func createTemp(dir, pattern string) (*os.File, error) {
	f, err := os.CreateTemp(dir, pattern)
	if err != nil {
		return nil, err
	}
	if err := f.Chmod(0o644); err != nil {
		f.Close()
		os.Remove(f.Name())
		return nil, err
	}
	return f, nil
}
