package linkpreview

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestFindFirstHTTPURL(t *testing.T) {
	got := FindFirstHTTPURL(`See (https://example.com/path?q=1), then http://later.test.`)
	if got != "https://example.com/path?q=1" {
		t.Fatalf("url = %q", got)
	}
}

func TestFetchScrapesOpenGraphMetadataAndThumbnail(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(`<html><head>
<meta property="og:title" content="OG Title">
<meta property="og:description" content="OG Description">
<meta property="og:image" content="/thumb.jpg">
</head></html>`))
	})
	mux.HandleFunc("/thumb.jpg", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/jpeg")
		_, _ = w.Write([]byte("jpeg"))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	got, err := Fetch(context.Background(), srv.Client(), srv.URL)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if got.URL != srv.URL {
		t.Fatalf("URL = %q", got.URL)
	}
	if got.Title != "OG Title" {
		t.Fatalf("Title = %q", got.Title)
	}
	if got.Description != "OG Description" {
		t.Fatalf("Description = %q", got.Description)
	}
	if string(got.Thumbnail) != "jpeg" {
		t.Fatalf("Thumbnail = %q", string(got.Thumbnail))
	}
}

func TestFetchReportsMissingMetadata(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`<html><head></head><body>empty</body></html>`))
	}))
	t.Cleanup(srv.Close)

	if _, err := Fetch(context.Background(), srv.Client(), srv.URL); err == nil {
		t.Fatalf("expected missing metadata error")
	}
}

func TestFetchFallsBackToTitle(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`<html><head><title>  Plain   Title  </title></head></html>`))
	}))
	t.Cleanup(srv.Close)

	got, err := Fetch(context.Background(), srv.Client(), srv.URL)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if got.Title != "Plain Title" {
		t.Fatalf("Title = %q", got.Title)
	}
}

func TestFetchRejectsInvalidURL(t *testing.T) {
	if _, err := Fetch(context.Background(), nil, "file:///tmp/page.html"); err == nil {
		t.Fatalf("expected invalid URL error")
	}
}
