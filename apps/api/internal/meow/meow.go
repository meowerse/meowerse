package meow

import "context"

// Meow is a single posted message.
type Meow struct {
	ID        int64  `json:"id"`
	Text      string `json:"text"`
	Slug      string `json:"slug"`
	CreatedAt string `json:"created_at"`
}

// Store is the persistence port for meows.
type Store interface {
	Migrate(ctx context.Context) error
	Create(ctx context.Context, text string) (Meow, error)
	List(ctx context.Context) ([]Meow, error)
}
