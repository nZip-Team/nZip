package main

import (
	"archive/zip"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// packZip creates a zip archive at downloadDir/filename containing every
// image file referenced in cfg.Images that exists on disk.
//
// The function respects ctx cancellation: if the context is cancelled while
// adding entries the archive is removed and an error is returned.
func packZip(ctx context.Context, cfg DownloadConfig) error {
	zipPath := filepath.Join(cfg.DownloadDir, cfg.Filename)

	// Collect files that are actually present on disk.
	var filePaths []string
	for _, url := range cfg.Images {
		name := filepath.Base(url)
		p := filepath.Join(cfg.DownloadDir, name)
		if st, err := os.Stat(p); err == nil && st.Size() > 0 {
			filePaths = append(filePaths, p)
		} else {
			logWarn("Pack zip: skipping missing/empty file %s for %s", name, cfg.Hash)
		}
	}

	if len(filePaths) == 0 {
		return fmt.Errorf("no files to pack for %s", cfg.Hash)
	}

	// Write to a temp file then rename for atomicity.
	tmp := zipPath + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return fmt.Errorf("create tmp zip: %w", err)
	}

	zw := zip.NewWriter(f)

	for _, src := range filePaths {
		if ctx.Err() != nil {
			zw.Close()
			f.Close()
			os.Remove(tmp)
			return ctx.Err()
		}
		if err := addFileToZip(zw, src); err != nil {
			zw.Close()
			f.Close()
			os.Remove(tmp)
			return fmt.Errorf("add %s: %w", src, err)
		}
	}

	if err := zw.Close(); err != nil {
		f.Close()
		os.Remove(tmp)
		return fmt.Errorf("close zip writer: %w", err)
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("close zip file: %w", err)
	}

	if err := os.Rename(tmp, zipPath); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("rename zip: %w", err)
	}

	logInfo("Pack zip: created %s (%d files)", cfg.Filename, len(filePaths))
	return nil
}

// addFileToZip streams src into the given ZipWriter under its base name.
func addFileToZip(zw *zip.Writer, src string) error {
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
	h.Name = filepath.Base(src)
	h.Method = zip.Store

	w, err := zw.CreateHeader(h)
	if err != nil {
		return err
	}

	_, err = io.Copy(w, in)
	return err
}
