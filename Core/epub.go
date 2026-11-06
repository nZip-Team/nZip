package main

import (
	"archive/zip"
	"context"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

var xmlEscaper = strings.NewReplacer(
	"&", "&amp;",
	"<", "&lt;",
	">", "&gt;",
	`"`, "&quot;",
	"'", "&apos;",
)

func packEPUB(ctx context.Context, filePaths []string, outputPath, title, identifier string) error {
	return buildArchiveFile(ctx, outputPath, packSlots, func(f *os.File) error {
		zw := zip.NewWriter(f)

		// First, stored, no extra field or data descriptor: readers sniff the type from fixed offsets.
		if err := addRawStoredStringToZip(zw, "mimetype", "application/epub+zip"); err != nil {
			return fmt.Errorf("write epub mimetype: %w", err)
		}

		if err := addStringToZip(zw, "META-INF/container.xml", epubContainerXML, zip.Deflate); err != nil {
			return fmt.Errorf("write epub container: %w", err)
		}

		if err := addStringToZip(zw, "OEBPS/style.css", epubStyleCSS, zip.Deflate); err != nil {
			return fmt.Errorf("write epub stylesheet: %w", err)
		}

		pageEntries := make([]epubPageEntry, 0, len(filePaths))
		for i, src := range filePaths {
			if ctx.Err() != nil {
				return ctx.Err()
			}

			pageID := fmt.Sprintf("page-%04d", i+1)
			pageHref := fmt.Sprintf("pages/%s.xhtml", pageID)
			imageID := fmt.Sprintf("img-%04d", i+1)
			imageHref := "images/" + pageID + strings.ToLower(filepath.Ext(src))

			// Stored, not deflated: these payloads are already compressed.
			if err := addFileToZip(zw, src, "OEBPS/"+imageHref); err != nil {
				return fmt.Errorf("write epub image %s: %w", src, err)
			}

			pageDoc := buildEPUBPageXHTML(i+1, "../"+imageHref)
			if err := addStringToZip(zw, "OEBPS/"+pageHref, pageDoc, zip.Deflate); err != nil {
				return fmt.Errorf("write epub page %s: %w", pageID, err)
			}

			pageEntries = append(pageEntries, epubPageEntry{
				PageID:     pageID,
				PageHref:   pageHref,
				Label:      fmt.Sprintf("Page %d", i+1),
				ImageID:    imageID,
				ImageHref:  imageHref,
				ImageMedia: epubMediaTypeForPath(imageHref),
			})
		}

		if err := addStringToZip(zw, "OEBPS/toc.ncx", buildEPUBNCX(title, identifier, pageEntries), zip.Deflate); err != nil {
			return fmt.Errorf("write epub toc: %w", err)
		}

		if err := addStringToZip(zw, "OEBPS/content.opf", buildEPUBOPF(title, identifier, pageEntries), zip.Deflate); err != nil {
			return fmt.Errorf("write epub package: %w", err)
		}

		if err := zw.Close(); err != nil {
			return fmt.Errorf("close epub writer: %w", err)
		}
		return nil
	})
}

type epubPageEntry struct {
	PageID     string
	PageHref   string
	Label      string
	ImageID    string
	ImageHref  string
	ImageMedia string
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

func buildEPUBPageXHTML(pageNumber int, imageSrc string) string {
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
`, pageNumber, escapeXML(imageSrc), pageNumber)
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
`)
	// OPF 2.0 spells the cover this way; properties="cover-image" is EPUB 3.
	if len(entries) > 0 {
		b.WriteString(`    <meta name="cover" content="`)
		b.WriteString(escapeXML(entries[0].ImageID))
		b.WriteString(`"/>` + "\n")
	}
	b.WriteString(`  </metadata>
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

		b.WriteString(`    <item id="`)
		b.WriteString(entry.ImageID)
		b.WriteString(`" href="`)
		b.WriteString(escapeXML(entry.ImageHref))
		b.WriteString(`" media-type="`)
		b.WriteString(entry.ImageMedia)
		b.WriteString(`"/>` + "\n")
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
