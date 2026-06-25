package main

import (
	"context"
	"database/sql"
	"log"
	"os"

	"github.com/meowerse/meowerse/api/internal/auth"
	"github.com/meowerse/meowerse/api/internal/health"
	"github.com/meowerse/meowerse/api/internal/meow"
	"github.com/gofiber/fiber/v2"
	"github.com/tursodatabase/libsql-client-go/libsql"
)

func main() {
	// The libSQL connector takes the bare libsql:// URL plus the auth token as
	// an option. This driver version forbids passing the token as a query
	// parameter on the connector path, so WithAuthToken is the correct API.
	connector, err := libsql.NewConnector(
		os.Getenv("DATABASE_URL"),
		libsql.WithAuthToken(os.Getenv("DATABASE_AUTH_TOKEN")),
	)
	if err != nil {
		log.Fatal(err)
	}
	db := sql.OpenDB(connector)

	store := meow.NewSQLiteStore(db)
	if err := store.Migrate(context.Background()); err != nil {
		log.Fatal(err)
	}

	app := fiber.New()
	app.Get("/healthz", health.Handler)
	api := app.Group("/api", auth.RequireToken(os.Getenv("API_TOKEN")))
	meow.RegisterRoutes(api, store)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	log.Fatal(app.Listen(":" + port))
}
