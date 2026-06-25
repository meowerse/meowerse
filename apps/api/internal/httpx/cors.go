// Package httpx holds small, unit-testable HTTP middleware helpers.
package httpx

import (
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
)

// DefaultOrigins is the allowlist used when CORS_ORIGINS is unset.
const DefaultOrigins = "https://meow.alxnko.eu.org,http://localhost:4321"

// CORS returns Fiber's CORS middleware configured with a strict origin
// allowlist. Origins is a comma-separated list; when empty, DefaultOrigins is
// used. Because credentials are allowed, a wildcard "*" origin is never used —
// only the explicit allowlist is honored.
func CORS(origins string) fiber.Handler {
	origins = strings.TrimSpace(origins)
	if origins == "" {
		origins = DefaultOrigins
	}
	return cors.New(cors.Config{
		AllowOrigins:     origins,
		AllowMethods:     "GET,POST,OPTIONS",
		AllowHeaders:     "Authorization,Content-Type",
		AllowCredentials: true,
	})
}
