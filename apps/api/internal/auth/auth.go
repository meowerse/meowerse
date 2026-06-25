package auth

import (
	"crypto/subtle"
	"strings"

	"github.com/gofiber/fiber/v2"
)

// RequireToken returns middleware enforcing "Authorization: Bearer <token>".
// The comparison is constant-time to avoid leaking the token via timing.
func RequireToken(token string) fiber.Handler {
	want := []byte(token)
	return func(c *fiber.Ctx) error {
		got := strings.TrimPrefix(c.Get("Authorization"), "Bearer ")
		if subtle.ConstantTimeCompare([]byte(got), want) != 1 {
			return fiber.NewError(fiber.StatusUnauthorized, "unauthorized")
		}
		return c.Next()
	}
}
