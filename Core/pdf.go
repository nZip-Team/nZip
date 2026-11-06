package main

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/draw"
	"os"
	"strings"

	"github.com/phpdave11/gofpdf"

	_ "image/gif"
	_ "image/jpeg"
	png "image/png"

	_ "golang.org/x/image/webp"
)

// Decoders allocate from the header alone, so a tiny crafted file can OOM-kill the process.
const (
	maxImagePixels    = 100_000_000
	maxImageDimension = 65_535
	// A re-encode holds the decoded image plus an NRGBA copy, about 8 bytes a pixel.
	maxPDFReencodePixels = 40_000_000
	// PDF readers reject pages past 14,400pt (200in) on a side.
	maxPDFPageSide = 14_400.0
)

var pdfImageTypes = map[string]string{
	"gif":  "GIF",
	"jpeg": "JPG",
	"jpg":  "JPG",
	"png":  "PNG",
}

// checkImageBounds validates header dimensions before anything allocates from them.
func checkImageBounds(width, height int) error {
	if width <= 0 || height <= 0 {
		return fmt.Errorf("invalid image dimensions %dx%d", width, height)
	}

	if width > maxImageDimension || height > maxImageDimension {
		return fmt.Errorf("image dimensions %dx%d exceed the %d pixel per-side limit", width, height, maxImageDimension)
	}

	if int64(width)*int64(height) > maxImagePixels {
		return fmt.Errorf("image %dx%d exceeds the %d pixel limit", width, height, maxImagePixels)
	}

	return nil
}

func packPDF(ctx context.Context, filePaths []string, outputPath string) error {
	// Built under the lock, so a replica never assembles a PDF that is already on disk.
	return buildArchiveFile(ctx, outputPath, pdfSlots, func(f *os.File) error {
		pdf := gofpdf.NewCustom(&gofpdf.InitType{
			UnitStr: "pt",
		})
		pdf.SetMargins(0, 0, 0)
		pdf.SetAutoPageBreak(false, 0)

		for i, src := range filePaths {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if err := addPDFPage(pdf, i, src); err != nil {
				return err
			}
		}

		if err := pdf.Error(); err != nil {
			return fmt.Errorf("build pdf: %w", err)
		}
		if err := pdf.Output(f); err != nil {
			return fmt.Errorf("write pdf: %w", err)
		}
		return nil
	})
}

// pdfPageSize maps pixels to points one to one, scaled down to fit the PDF page limit.
func pdfPageSize(width, height int) gofpdf.SizeType {
	w, h := float64(width), float64(height)
	if longest := max(w, h); longest > maxPDFPageSide {
		scale := maxPDFPageSide / longest
		w, h = w*scale, h*scale
	}
	return gofpdf.SizeType{Wd: w, Ht: h}
}

// addPDFPage registers one image as a full-bleed page.
func addPDFPage(pdf *gofpdf.Fpdf, index int, src string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return fmt.Errorf("read %s: %w", src, err)
	}

	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return fmt.Errorf("decode %s: %w", src, err)
	}

	if err := checkImageBounds(cfg.Width, cfg.Height); err != nil {
		return fmt.Errorf("reject %s: %w", src, err)
	}

	pdfData, imageType, err := normalizePDFImageData(data, format)
	if err != nil {
		return fmt.Errorf("prepare %s for pdf: %w", src, err)
	}
	data = nil

	pageSize := pdfPageSize(cfg.Width, cfg.Height)
	orientation := "P"
	if pageSize.Wd > pageSize.Ht {
		orientation = "L"
	}

	alias := fmt.Sprintf("page-%d", index)
	opts := gofpdf.ImageOptions{
		ImageType: imageType,
		ReadDpi:   true,
	}

	pdf.AddPageFormat(orientation, pageSize)
	pdf.RegisterImageOptionsReader(alias, opts, bytes.NewReader(pdfData))
	pdfData = nil // gofpdf owns its copy from here on

	pdf.ImageOptions(alias, 0, 0, pageSize.Wd, pageSize.Ht, false, opts, 0, "")
	return nil
}

func normalizePDFImageData(data []byte, format string) ([]byte, string, error) {
	format = strings.ToLower(format)
	if imageType, ok := pdfImageTypes[format]; ok && imageType != "PNG" {
		return data, imageType, nil
	}

	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, "", err
	}

	if err := checkImageBounds(cfg.Width, cfg.Height); err != nil {
		return nil, "", err
	}

	// Only PNGs gofpdf cannot embed are worth a decode and re-encode.
	if format == "png" && !pngNeedsPDFReencode(data) {
		return data, "PNG", nil
	}

	if int64(cfg.Width)*int64(cfg.Height) > maxPDFReencodePixels {
		return nil, "", fmt.Errorf("image %dx%d is too large to re-encode for pdf (limit %d pixels)", cfg.Width, cfg.Height, maxPDFReencodePixels)
	}

	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, "", err
	}

	bounds := img.Bounds()
	normalized := image.NewNRGBA(bounds)
	draw.Draw(normalized, bounds, img, bounds.Min, draw.Src)
	img = nil

	var converted bytes.Buffer
	if err := png.Encode(&converted, normalized); err != nil {
		return nil, "", fmt.Errorf("encode png: %w", err)
	}

	return converted.Bytes(), "PNG", nil
}

const pngSignature = "\x89PNG\r\n\x1a\n"

// pngNeedsPDFReencode reads the IHDR fields gofpdf refuses: depth over 8, interlacing, exotic colour types.
func pngNeedsPDFReencode(data []byte) bool {
	if len(data) < 29 || string(data[:8]) != pngSignature || string(data[12:16]) != "IHDR" {
		return true
	}

	bitDepth, colorType, interlace := data[24], data[25], data[28]
	if bitDepth > 8 || interlace != 0 {
		return true
	}

	switch colorType {
	case 0, 2, 3, 4, 6:
		return false
	default:
		return true
	}
}
