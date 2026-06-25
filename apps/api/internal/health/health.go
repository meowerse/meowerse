package health

import "github.com/gofiber/fiber/v2"

// Handler responds with a static health payload for liveness checks.
func Handler(c *fiber.Ctx) error {
	return c.JSON(fiber.Map{"status": "ok"})
}
