package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"image/draw"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/phpdave11/gofpdf"

	_ "image/gif"
	_ "image/jpeg"
	png "image/png"

	_ "golang.org/x/image/webp"
)

var pdfImageTypes = map[string]string{
	"gif":  "GIF",
	"jpeg": "JPG",
	"jpg":  "JPG",
	"png":  "PNG",
}

var xmlEscaper = strings.NewReplacer(
	"&", "&amp;",
	"<", "&lt;",
	">", "&gt;",
	`"`, "&quot;",
	"'", "&apos;",
)

const (
	archiveLockPollInterval = 200 * time.Millisecond
	archiveLockStaleAfter   = 15 * time.Minute
)

// packArchives creates the initial fast-path download artifacts.
func packArchives(ctx context.Context, cfg DownloadConfig) (err error) {
	filePaths, err := collectExistingImageFiles(cfg)
	if err != nil {
		return err
	}

	zipPath := filepath.Join(cfg.DownloadDir, cfg.Filename)
	artifacts := []string{zipPath}

	defer func() {
		if err != nil {
			for _, artifact := range artifacts {
				_ = os.Remove(artifact)
			}
		}
	}()

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	type packTask struct {
		name string
		run  func() error
	}

	tasks := []packTask{
		{
			name: "zip",
			run: func() error {
				return packZipLike(ctx, filePaths, zipPath, nil)
			},
		},
	}

	errCh := make(chan error, len(tasks))
	var wg sync.WaitGroup

	for _, task := range tasks {
		wg.Add(1)
		go func(task packTask) {
			defer wg.Done()
			if taskErr := task.run(); taskErr != nil {
				select {
				case errCh <- fmt.Errorf("pack %s: %w", task.name, taskErr):
				default:
				}
				cancel()
			}
		}(task)
	}

	wg.Wait()
	close(errCh)

	for taskErr := range errCh {
		if taskErr != nil {
			err = taskErr
			return err
		}
	}

	logInfo("Pack archives: created %s", filepath.Base(zipPath))
	return nil
}

func packArchiveFormat(ctx context.Context, cfg DownloadConfig, format string) error {
	filePaths, err := collectExistingImageFiles(cfg)
	if err != nil {
		return err
	}

	basePath := filepath.Join(cfg.DownloadDir, cfg.Filename)
	switch format {
	case "zip":
		return packZipLike(ctx, filePaths, archivePathWithExt(basePath, ".zip"), nil)
	case "cbz":
		return packZipLike(ctx, filePaths, archivePathWithExt(basePath, ".cbz"), cbzEntryNamer(filePaths))
	case "pdf":
		return packPDF(ctx, filePaths, archivePathWithExt(basePath, ".pdf"))
	case "epub":
		title := strings.TrimSuffix(filepath.Base(cfg.Filename), filepath.Ext(cfg.Filename))
		return packEPUB(ctx, filePaths, archivePathWithExt(basePath, ".epub"), title, cfg.Hash)
	default:
		return fmt.Errorf("unsupported archive format: %s", format)
	}
}

func collectExistingImageFiles(cfg DownloadConfig) ([]string, error) {
	if len(cfg.Images) == 0 {
		return collectExistingImageFilesFromDisk(cfg.DownloadDir, cfg.Hash)
	}

	var filePaths []string
	for _, url := range cfg.Images {
		name := filepath.Base(url)
		p := filepath.Join(cfg.DownloadDir, name)
		if st, err := os.Stat(p); err == nil && st.Size() > 0 {
			filePaths = append(filePaths, p)
		} else {
			logWarn("Pack archives: skipping missing/empty file %s for %s", name, cfg.Hash)
		}
	}
	if len(filePaths) == 0 {
		return nil, fmt.Errorf("no files to pack for %s", cfg.Hash)
	}
	return filePaths, nil
}

func collectExistingImageFilesFromDisk(downloadDir, hash string) ([]string, error) {
	entries, err := os.ReadDir(downloadDir)
	if err != nil {
		return nil, fmt.Errorf("read download directory for %s: %w", hash, err)
	}

	filePaths := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !isDownloadImageFile(entry.Name()) {
			continue
		}

		p := filepath.Join(downloadDir, entry.Name())
		if st, err := os.Stat(p); err == nil && st.Size() > 0 {
			filePaths = append(filePaths, p)
		} else {
			logWarn("Pack archives: skipping missing/empty file %s for %s", entry.Name(), hash)
		}
	}

	sort.Slice(filePaths, func(i, j int) bool {
		return compareArchiveImageNames(filepath.Base(filePaths[i]), filepath.Base(filePaths[j])) < 0
	})

	if len(filePaths) == 0 {
		return nil, fmt.Errorf("no files to pack for %s", hash)
	}

	return filePaths, nil
}

func isDownloadImageFile(name string) bool {
	ext := strings.ToLower(filepath.Ext(name))
	switch ext {
	case ".jpg", ".jpeg", ".png", ".gif", ".webp":
		return true
	default:
		return false
	}
}

func compareArchiveImageNames(left, right string) int {
	leftStem := strings.TrimSuffix(left, filepath.Ext(left))
	rightStem := strings.TrimSuffix(right, filepath.Ext(right))

	leftNum, leftErr := strconv.Atoi(leftStem)
	rightNum, rightErr := strconv.Atoi(rightStem)

	if leftErr == nil && rightErr == nil {
		switch {
		case leftNum < rightNum:
			return -1
		case leftNum > rightNum:
			return 1
		default:
			return strings.Compare(left, right)
		}
	}

	return strings.Compare(left, right)
}

func archivePathWithExt(src, ext string) string {
	return strings.TrimSuffix(src, filepath.Ext(src)) + ext
}

func packZipLike(ctx context.Context, filePaths []string, outputPath string, entryName func(src string) string) error {
	return buildArchiveFile(ctx, outputPath, func(tmp string) error {
		f, err := os.Create(tmp)
		if err != nil {
			return fmt.Errorf("create tmp archive: %w", err)
		}

		zw := zip.NewWriter(f)

		for _, src := range filePaths {
			if ctx.Err() != nil {
				_ = zw.Close()
				_ = f.Close()
				return ctx.Err()
			}
			name := filepath.Base(src)
			if entryName != nil {
				name = entryName(src)
			}
			if err := addFileToZip(zw, src, name); err != nil {
				_ = zw.Close()
				_ = f.Close()
				return fmt.Errorf("add %s: %w", src, err)
			}
		}

		if err := zw.Close(); err != nil {
			_ = f.Close()
			return fmt.Errorf("close zip writer: %w", err)
		}
		if err := f.Close(); err != nil {
			return fmt.Errorf("close archive file: %w", err)
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

func packPDF(ctx context.Context, filePaths []string, outputPath string) error {
	pdf := gofpdf.NewCustom(&gofpdf.InitType{
		UnitStr: "pt",
	})
	pdf.SetMargins(0, 0, 0)
	pdf.SetAutoPageBreak(false, 0)

	for i, src := range filePaths {
		if ctx.Err() != nil {
			return ctx.Err()
		}

		data, err := os.ReadFile(src)
		if err != nil {
			return fmt.Errorf("read %s: %w", src, err)
		}

		cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
		if err != nil {
			return fmt.Errorf("decode %s: %w", src, err)
		}

		pdfData, imageType, err := normalizePDFImageData(data, format)
		if err != nil {
			return fmt.Errorf("prepare %s for pdf: %w", src, err)
		}

		pageSize := gofpdf.SizeType{
			Wd: float64(cfg.Width),
			Ht: float64(cfg.Height),
		}
		orientation := "P"
		if pageSize.Wd > pageSize.Ht {
			orientation = "L"
		}

		alias := fmt.Sprintf("page-%d", i)
		opts := gofpdf.ImageOptions{
			ImageType: imageType,
			ReadDpi:   true,
		}

		pdf.AddPageFormat(orientation, pageSize)
		pdf.RegisterImageOptionsReader(alias, opts, bytes.NewReader(pdfData))
		pdf.ImageOptions(alias, 0, 0, pageSize.Wd, pageSize.Ht, false, opts, 0, "")
	}

	if err := pdf.Error(); err != nil {
		return fmt.Errorf("build pdf: %w", err)
	}

	return buildArchiveFile(ctx, outputPath, func(tmp string) error {
		f, err := os.Create(tmp)
		if err != nil {
			return fmt.Errorf("create tmp pdf: %w", err)
		}

		if err := pdf.Output(f); err != nil {
			_ = f.Close()
			return fmt.Errorf("write pdf: %w", err)
		}
		if err := f.Close(); err != nil {
			return fmt.Errorf("close pdf file: %w", err)
		}

		return nil
	})
}

func packEPUB(ctx context.Context, filePaths []string, outputPath, title, identifier string) error {
	return buildArchiveFile(ctx, outputPath, func(tmp string) error {
		f, err := os.Create(tmp)
		if err != nil {
			return fmt.Errorf("create tmp epub: %w", err)
		}

		zw := zip.NewWriter(f)

		if err := addStringToZip(zw, "mimetype", "application/epub+zip", zip.Store); err != nil {
			_ = zw.Close()
			_ = f.Close()
			return fmt.Errorf("write epub mimetype: %w", err)
		}

		if err := addStringToZip(zw, "META-INF/container.xml", epubContainerXML, zip.Deflate); err != nil {
			_ = zw.Close()
			_ = f.Close()
			return fmt.Errorf("write epub container: %w", err)
		}

		if err := addStringToZip(zw, "OEBPS/style.css", epubStyleCSS, zip.Deflate); err != nil {
			_ = zw.Close()
			_ = f.Close()
			return fmt.Errorf("write epub stylesheet: %w", err)
		}

		pageEntries := make([]epubPageEntry, 0, len(filePaths))
		for i, src := range filePaths {
			if ctx.Err() != nil {
				_ = zw.Close()
				_ = f.Close()
				return ctx.Err()
			}

			imageName := filepath.Base(src)
			imageType := epubMediaTypeForPath(imageName)
			pageID := fmt.Sprintf("page-%04d", i+1)
			pageHref := fmt.Sprintf("pages/%s.xhtml", pageID)
			pagePath := "OEBPS/" + pageHref

			imageBytes, err := os.ReadFile(src)
			if err != nil {
				_ = zw.Close()
				_ = f.Close()
				return fmt.Errorf("read epub image %s: %w", src, err)
			}

			pageDoc := buildEPUBPageXHTML(i+1, imageName, imageType, imageBytes)
			if err := addStringToZip(zw, pagePath, pageDoc, zip.Deflate); err != nil {
				_ = zw.Close()
				_ = f.Close()
				return fmt.Errorf("write epub page %s: %w", pageID, err)
			}

			pageEntries = append(pageEntries, epubPageEntry{
				PageID:   pageID,
				PageHref: pageHref,
				Label:    fmt.Sprintf("Page %d", i+1),
			})
		}

		if err := addStringToZip(zw, "OEBPS/toc.ncx", buildEPUBNCX(title, identifier, pageEntries), zip.Deflate); err != nil {
			_ = zw.Close()
			_ = f.Close()
			return fmt.Errorf("write epub toc: %w", err)
		}

		if err := addStringToZip(zw, "OEBPS/content.opf", buildEPUBOPF(title, identifier, pageEntries), zip.Deflate); err != nil {
			_ = zw.Close()
			_ = f.Close()
			return fmt.Errorf("write epub package: %w", err)
		}

		if err := zw.Close(); err != nil {
			_ = f.Close()
			return fmt.Errorf("close epub writer: %w", err)
		}
		if err := f.Close(); err != nil {
			return fmt.Errorf("close epub file: %w", err)
		}

		return nil
	})
}

func normalizePDFImageData(data []byte, format string) ([]byte, string, error) {
	if imageType, ok := pdfImageTypes[strings.ToLower(format)]; ok && imageType != "PNG" {
		return data, imageType, nil
	}

	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, "", err
	}

	// gofpdf rejects 16-bit PNG payloads, so normalize every non-JPEG/GIF
	// image to an 8-bit RGBA PNG before embedding it into the PDF.
	bounds := img.Bounds()
	normalized := image.NewNRGBA(bounds)
	draw.Draw(normalized, bounds, img, bounds.Min, draw.Src)

	var converted bytes.Buffer
	if err := png.Encode(&converted, normalized); err != nil {
		return nil, "", fmt.Errorf("encode png: %w", err)
	}

	return converted.Bytes(), "PNG", nil
}

func buildArchiveFile(ctx context.Context, outputPath string, build func(tmpPath string) error) error {
	if archiveExists(outputPath) {
		return nil
	}

	release, err := acquireArchiveBuildLock(ctx, outputPath)
	if err != nil {
		return err
	}
	if release == nil {
		return nil
	}
	defer release()

	if archiveExists(outputPath) {
		return nil
	}

	tmpFile, err := os.CreateTemp(filepath.Dir(outputPath), filepath.Base(outputPath)+".*.tmp")
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}
	tmpPath := tmpFile.Name()
	if err := tmpFile.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("close temp file: %w", err)
	}
	defer os.Remove(tmpPath)

	if err := build(tmpPath); err != nil {
		return err
	}

	if archiveExists(outputPath) {
		return nil
	}

	if err := os.Rename(tmpPath, outputPath); err != nil {
		if archiveExists(outputPath) {
			return nil
		}
		return fmt.Errorf("rename archive: %w", err)
	}

	return nil
}

func archiveExists(outputPath string) bool {
	st, err := os.Stat(outputPath)
	return err == nil && st.Size() > 0
}

func acquireArchiveBuildLock(ctx context.Context, outputPath string) (func(), error) {
	lockPath := outputPath + ".lock"

	for {
		lockFile, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err == nil {
			_, _ = fmt.Fprintf(lockFile, "%d\n%d\n", os.Getpid(), time.Now().Unix())
			_ = lockFile.Close()
			return func() {
				_ = os.Remove(lockPath)
			}, nil
		}

		if !errors.Is(err, os.ErrExist) {
			return nil, fmt.Errorf("acquire archive lock: %w", err)
		}

		if archiveExists(outputPath) {
			return nil, nil
		}

		if isStaleArchiveLock(lockPath) {
			_ = os.Remove(lockPath)
			continue
		}

		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(archiveLockPollInterval):
		}
	}
}

func isStaleArchiveLock(lockPath string) bool {
	st, err := os.Stat(lockPath)
	if err != nil {
		return false
	}
	return time.Since(st.ModTime()) > archiveLockStaleAfter
}

type epubPageEntry struct {
	PageID   string
	PageHref string
	Label    string
}

const epubContainerXML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`

const epubStyleCSS = `html, body {
  margin: 0;
  padding: 0;
  background: #111;
}

body {
  text-align: center;
}

.page {
  margin: 0;
  padding: 0;
}

img {
  display: block;
  width: 100%;
  height: auto;
}
`

func buildEPUBPageXHTML(pageNumber int, imageName, imageType string, imageBytes []byte) string {
	dataURL := "data:" + imageType + ";base64," + base64.StdEncoding.EncodeToString(imageBytes)
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en">
  <head>
    <title>Page %d</title>
    <meta http-equiv="Content-Type" content="application/xhtml+xml; charset=UTF-8"/>
    <link rel="stylesheet" type="text/css" href="../style.css"/>
  </head>
  <body>
    <div class="page">
      <img src="%s" alt="Page %d"/>
    </div>
  </body>
</html>
`, pageNumber, escapeXML(dataURL), pageNumber)
}

func buildEPUBNCX(title, identifier string, entries []epubPageEntry) string {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="`)
	b.WriteString(escapeXML(epubIdentifier(identifier)))
	b.WriteString(`"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>`)
	b.WriteString(escapeXML(title))
	b.WriteString(`</text></docTitle>
  <navMap>
`)
	for i, entry := range entries {
		b.WriteString(`    <navPoint id="navPoint-`)
		b.WriteString(strconv.Itoa(i + 1))
		b.WriteString(`" playOrder="`)
		b.WriteString(strconv.Itoa(i + 1))
		b.WriteString(`">
      <navLabel><text>`)
		b.WriteString(escapeXML(entry.Label))
		b.WriteString(`</text></navLabel>
      <content src="`)
		b.WriteString(escapeXML(entry.PageHref))
		b.WriteString(`"/>
    </navPoint>
`)
	}
	b.WriteString(`  </navMap>
</ncx>
`)
	return b.String()
}

func buildEPUBOPF(title, identifier string, entries []epubPageEntry) string {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>
<package version="2.0" unique-identifier="bookid" xmlns="http://www.idpf.org/2007/opf">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">`)
	b.WriteString(escapeXML(epubIdentifier(identifier)))
	b.WriteString(`</dc:identifier>
    <dc:title>`)
	b.WriteString(escapeXML(title))
	b.WriteString(`</dc:title>
    <dc:creator>nZip</dc:creator>
    <dc:language>en</dc:language>
    <meta name="generator" content="nZip"/>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="style" href="style.css" media-type="text/css"/>
`)
	for _, entry := range entries {
		b.WriteString(`    <item id="`)
		b.WriteString(entry.PageID)
		b.WriteString(`" href="`)
		b.WriteString(escapeXML(entry.PageHref))
		b.WriteString(`" media-type="application/xhtml+xml"/>` + "\n")
	}
	b.WriteString(`  </manifest>
  <spine toc="ncx">
`)
	for _, entry := range entries {
		b.WriteString(`    <itemref idref="`)
		b.WriteString(entry.PageID)
		b.WriteString(`"/>` + "\n")
	}
	b.WriteString(`  </spine>
</package>
`)
	return b.String()
}

func epubMediaTypeForPath(fileName string) string {
	switch strings.ToLower(filepath.Ext(fileName)) {
	case ".gif":
		return "image/gif"
	case ".jpeg", ".jpg":
		return "image/jpeg"
	case ".png":
		return "image/png"
	case ".webp":
		return "image/webp"
	default:
		return "application/octet-stream"
	}
}

func epubIdentifier(src string) string {
	sum := sha1.Sum([]byte(src))
	return "urn:nzip:" + hex.EncodeToString(sum[:])
}

func escapeXML(src string) string {
	return xmlEscaper.Replace(src)
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
