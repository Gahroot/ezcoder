package main

import (
	"errors"
	"fmt"
	"os"
	"time"

	ez "github.com/Gahroot/ezcoder/packages/pixel-go"
)

func main() {
	key := os.Getenv("EZCODER_PIXEL_KEY")
	if key == "" {
		fmt.Fprintln(os.Stderr, "set EZCODER_PIXEL_KEY=pk_live_...")
		os.Exit(1)
	}
	if err := ez.Init(ez.Options{ProjectKey: key}); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer ez.Close()
	defer ez.Recover()

	ez.Report("go-smoke: manual report from main()")
	ez.CaptureError(errors.New("go-smoke: captured error via CaptureError"))

	time.Sleep(500 * time.Millisecond)

	// Now panic — Recover() captures and re-panics.
	var s []string
	_ = s[42] // index out of range
}
