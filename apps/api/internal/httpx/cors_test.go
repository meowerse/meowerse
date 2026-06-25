package httpx

import (
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
)

func appWithCORS(origins string) *fiber.App {
	app := fiber.New()
	app.Use(CORS(origins))
	app.Get("/x", func(c *fiber.Ctx) error { return c.SendString("ok") })
	return app
}

func TestAllowedOriginEchoed(t *testing.T) {
	app := appWithCORS("https://meow.alxnko.eu.org,http://localhost:4321")
	req := httptest.NewRequest("GET", "/x", nil)
	req.Header.Set("Origin", "https://meow.alxnko.eu.org")
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "https://meow.alxnko.eu.org" {
		t.Fatalf("Access-Control-Allow-Origin = %q", got)
	}
	if got := resp.Header.Get("Access-Control-Allow-Credentials"); got != "true" {
		t.Fatalf("Access-Control-Allow-Credentials = %q", got)
	}
}

func TestDisallowedOriginNotEchoed(t *testing.T) {
	app := appWithCORS("https://meow.alxnko.eu.org")
	req := httptest.NewRequest("GET", "/x", nil)
	req.Header.Set("Origin", "https://evil.example.com")
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got == "https://evil.example.com" {
		t.Fatalf("disallowed origin was echoed: %q", got)
	}
}

func TestPreflightAllowedOrigin(t *testing.T) {
	app := appWithCORS("https://meow.alxnko.eu.org,http://localhost:4321")
	req := httptest.NewRequest("OPTIONS", "/x", nil)
	req.Header.Set("Origin", "http://localhost:4321")
	req.Header.Set("Access-Control-Request-Method", "POST")
	req.Header.Set("Access-Control-Request-Headers", "Authorization")
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != fiber.StatusNoContent {
		t.Fatalf("preflight status = %d", resp.StatusCode)
	}
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "http://localhost:4321" {
		t.Fatalf("preflight Access-Control-Allow-Origin = %q", got)
	}
	if got := resp.Header.Get("Access-Control-Allow-Methods"); got == "" {
		t.Fatal("preflight Access-Control-Allow-Methods missing")
	}
}

func TestEmptyOriginsUsesDefault(t *testing.T) {
	app := appWithCORS("")
	req := httptest.NewRequest("GET", "/x", nil)
	req.Header.Set("Origin", "https://meow.alxnko.eu.org")
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "https://meow.alxnko.eu.org" {
		t.Fatalf("default allowlist did not echo origin: %q", got)
	}
}
