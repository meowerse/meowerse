package meow

import (
	"database/sql"
	"io"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
	_ "modernc.org/sqlite"
)

func appWithStore(t *testing.T) *fiber.App {
	db, _ := sql.Open("sqlite", ":memory:")
	s := NewSQLiteStore(db)
	if err := s.Migrate(t.Context()); err != nil {
		t.Fatal(err)
	}
	app := fiber.New()
	RegisterRoutes(app, s)
	return app
}

func TestPostThenGet(t *testing.T) {
	app := appWithStore(t)
	req := httptest.NewRequest("POST", "/meows", strings.NewReader(`{"text":"Meow Verse"}`))
	req.Header.Set("Content-Type", "application/json")
	resp, _ := app.Test(req)
	if resp.StatusCode != 201 {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("post status=%d body=%s", resp.StatusCode, b)
	}
	resp2, _ := app.Test(httptest.NewRequest("GET", "/meows", nil))
	body, _ := io.ReadAll(resp2.Body)
	if !strings.Contains(string(body), "meow-verse") {
		t.Fatalf("list body=%s", body)
	}
}

func TestPostEmptyIs400(t *testing.T) {
	app := appWithStore(t)
	req := httptest.NewRequest("POST", "/meows", strings.NewReader(`{"text":"  "}`))
	req.Header.Set("Content-Type", "application/json")
	resp, _ := app.Test(req)
	if resp.StatusCode != 400 {
		t.Fatalf("status=%d", resp.StatusCode)
	}
}

func TestPostBadJSONIs400(t *testing.T) {
	app := appWithStore(t)
	req := httptest.NewRequest("POST", "/meows", strings.NewReader(`not json`))
	req.Header.Set("Content-Type", "application/json")
	resp, _ := app.Test(req)
	if resp.StatusCode != 400 {
		t.Fatalf("status=%d", resp.StatusCode)
	}
}
