package auth

import (
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
)

func appWith(token string) *fiber.App {
	app := fiber.New()
	app.Use(RequireToken(token))
	app.Get("/x", func(c *fiber.Ctx) error { return c.SendString("ok") })
	return app
}

func TestRejectsMissing(t *testing.T) {
	resp, _ := appWith("secret").Test(httptest.NewRequest("GET", "/x", nil))
	if resp.StatusCode != 401 {
		t.Fatalf("status=%d", resp.StatusCode)
	}
}

func TestRejectsWrong(t *testing.T) {
	req := httptest.NewRequest("GET", "/x", nil)
	req.Header.Set("Authorization", "Bearer nope")
	resp, _ := appWith("secret").Test(req)
	if resp.StatusCode != 401 {
		t.Fatalf("status=%d", resp.StatusCode)
	}
}

func TestAllowsCorrect(t *testing.T) {
	req := httptest.NewRequest("GET", "/x", nil)
	req.Header.Set("Authorization", "Bearer secret")
	resp, _ := appWith("secret").Test(req)
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d", resp.StatusCode)
	}
}
