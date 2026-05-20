package linkpreview

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"golang.org/x/net/html"
)

const (
	maxHTMLBytes      = 1 << 20
	maxThumbnailBytes = 300 << 10
)

var httpURLPattern = regexp.MustCompile(`https?://[^\s<>"']+`)

type Preview struct {
	URL         string
	Title       string
	Description string
	Thumbnail   []byte
}

func FindFirstHTTPURL(text string) string {
	for _, match := range httpURLPattern.FindAllString(text, -1) {
		raw := trimURL(match)
		u, err := url.Parse(raw)
		if err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != "" {
			return raw
		}
	}
	return ""
}

func Fetch(ctx context.Context, client *http.Client, rawURL string) (*Preview, error) {
	u, err := url.Parse(rawURL)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, fmt.Errorf("invalid preview URL")
	}
	if client == nil {
		client = http.DefaultClient
	}

	doc, finalURL, err := fetchHTML(ctx, client, u.String())
	if err != nil {
		return nil, err
	}

	data := scrape(doc)
	if data.Title == "" && data.Description == "" && data.ImageURL == "" {
		return nil, fmt.Errorf("preview metadata not found")
	}

	preview := &Preview{
		URL:         u.String(),
		Title:       data.Title,
		Description: data.Description,
	}
	if data.ImageURL != "" {
		if imageURL, err := finalURL.Parse(data.ImageURL); err == nil {
			preview.Thumbnail = fetchThumbnail(ctx, client, imageURL.String())
		}
	}
	return preview, nil
}

func trimURL(raw string) string {
	raw = strings.TrimRight(raw, ".,!?;:")
	for {
		if strings.HasSuffix(raw, ")") && strings.Count(raw, "(") < strings.Count(raw, ")") {
			raw = strings.TrimSuffix(raw, ")")
			continue
		}
		if strings.HasSuffix(raw, "]") && strings.Count(raw, "[") < strings.Count(raw, "]") {
			raw = strings.TrimSuffix(raw, "]")
			continue
		}
		if strings.HasSuffix(raw, "}") && strings.Count(raw, "{") < strings.Count(raw, "}") {
			raw = strings.TrimSuffix(raw, "}")
			continue
		}
		return raw
	}
}

func fetchHTML(ctx context.Context, client *http.Client, rawURL string) (*html.Node, *url.URL, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("User-Agent", "wacli")

	resp, err := client.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, nil, fmt.Errorf("preview request failed: %s", resp.Status)
	}

	limited := io.LimitReader(resp.Body, maxHTMLBytes+1)
	body, err := io.ReadAll(limited)
	if err != nil {
		return nil, nil, err
	}
	if len(body) > maxHTMLBytes {
		return nil, nil, fmt.Errorf("preview HTML too large")
	}
	doc, err := html.Parse(strings.NewReader(string(body)))
	if err != nil {
		return nil, nil, err
	}
	return doc, resp.Request.URL, nil
}

func fetchThumbnail(ctx context.Context, client *http.Client, rawURL string) []byte {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil
	}
	req.Header.Set("User-Agent", "wacli")

	resp, err := client.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil
	}
	if contentType := resp.Header.Get("Content-Type"); contentType != "" && !strings.HasPrefix(strings.ToLower(contentType), "image/") {
		return nil
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxThumbnailBytes+1))
	if err != nil || len(body) > maxThumbnailBytes {
		return nil
	}
	return body
}

type metadata struct {
	Title       string
	Description string
	ImageURL    string
}

func scrape(node *html.Node) metadata {
	var data metadata
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode {
			switch n.Data {
			case "meta":
				applyMeta(&data, n)
			case "title":
				if data.Title == "" {
					data.Title = nodeText(n)
				}
			}
		}
		for child := n.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
	}
	walk(node)
	data.Title = clean(data.Title)
	data.Description = clean(data.Description)
	data.ImageURL = clean(data.ImageURL)
	return data
}

func applyMeta(data *metadata, n *html.Node) {
	key := strings.ToLower(firstAttr(n, "property"))
	if key == "" {
		key = strings.ToLower(firstAttr(n, "name"))
	}
	content := clean(firstAttr(n, "content"))
	if key == "" || content == "" {
		return
	}

	switch key {
	case "og:title", "twitter:title":
		data.Title = pick(data.Title, content)
	case "og:description", "twitter:description", "description":
		data.Description = pick(data.Description, content)
	case "og:image", "og:image:url", "twitter:image", "twitter:image:src":
		data.ImageURL = pick(data.ImageURL, content)
	}
}

func firstAttr(n *html.Node, name string) string {
	for _, attr := range n.Attr {
		if strings.EqualFold(attr.Key, name) {
			return attr.Val
		}
	}
	return ""
}

func nodeText(n *html.Node) string {
	var b strings.Builder
	var walk func(*html.Node)
	walk = func(node *html.Node) {
		if node.Type == html.TextNode {
			b.WriteString(node.Data)
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
	}
	walk(n)
	return b.String()
}

func clean(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

func pick(current, next string) string {
	if current != "" {
		return current
	}
	return next
}
