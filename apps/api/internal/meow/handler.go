package meow

import (
	"errors"

	"github.com/gofiber/fiber/v2"
)

// Router is the subset of *fiber.App / fiber.Router needed to register routes,
// allowing handlers to be mounted on a group (e.g. an authed /api group) too.
type Router interface {
	Post(path string, handlers ...fiber.Handler) fiber.Router
	Get(path string, handlers ...fiber.Handler) fiber.Router
}

// RegisterRoutes mounts the meow create/list endpoints on the given router.
func RegisterRoutes(r Router, store Store) {
	r.Post("/meows", func(c *fiber.Ctx) error {
		var in struct {
			Text string `json:"text"`
		}
		if err := c.BodyParser(&in); err != nil {
			return fiber.NewError(fiber.StatusBadRequest, "invalid body")
		}
		m, err := store.Create(c.Context(), in.Text)
		if errors.Is(err, ErrEmptyText) {
			return fiber.NewError(fiber.StatusBadRequest, err.Error())
		}
		if err != nil {
			return fiber.NewError(fiber.StatusInternalServerError, "create failed")
		}
		return c.Status(fiber.StatusCreated).JSON(m)
	})

	r.Get("/meows", func(c *fiber.Ctx) error {
		list, err := store.List(c.Context())
		if err != nil {
			return fiber.NewError(fiber.StatusInternalServerError, "list failed")
		}
		return c.JSON(list)
	})
}
