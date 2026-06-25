package meow

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"github.com/meowerse/meowerse/go-shared/slug"
)

// ErrEmptyText is returned when a meow's text is blank after trimming.
var ErrEmptyText = errors.New("meow text must not be empty")

// SQLiteStore implements Store over any database/sql driver speaking SQLite
// dialect (modernc.org/sqlite in tests, libSQL in production).
type SQLiteStore struct{ db *sql.DB }

// NewSQLiteStore wraps an open *sql.DB.
func NewSQLiteStore(db *sql.DB) *SQLiteStore { return &SQLiteStore{db: db} }

// Migrate creates the meows table if it does not exist.
func (s *SQLiteStore) Migrate(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS meows (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			text TEXT NOT NULL,
			slug TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`)
	return err
}

// Create inserts a meow, deriving its slug from the trimmed text.
func (s *SQLiteStore) Create(ctx context.Context, text string) (Meow, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return Meow{}, ErrEmptyText
	}
	sl := slug.Slugify(text)
	res, err := s.db.ExecContext(ctx, `INSERT INTO meows (text, slug) VALUES (?, ?)`, text, sl)
	if err != nil {
		return Meow{}, err
	}
	id, _ := res.LastInsertId()
	var m Meow
	err = s.db.QueryRowContext(ctx, `SELECT id, text, slug, created_at FROM meows WHERE id = ?`, id).
		Scan(&m.ID, &m.Text, &m.Slug, &m.CreatedAt)
	return m, err
}

// List returns all meows, newest first.
func (s *SQLiteStore) List(ctx context.Context) ([]Meow, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, text, slug, created_at FROM meows ORDER BY id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Meow{}
	for rows.Next() {
		var m Meow
		if err := rows.Scan(&m.ID, &m.Text, &m.Slug, &m.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}
