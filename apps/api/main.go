package main

import (
	"log"
	"os"

	"github.com/alxnko/meowerse/api/internal/health"
	"github.com/gofiber/fiber/v2"
)

func main() {
	app := fiber.New()
	app.Get("/healthz", health.Handler)
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	log.Fatal(app.Listen(":" + port))
}
