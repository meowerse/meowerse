package meow

import (
	"context"
	"database/sql"
	"testing"

	_ "modernc.org/sqlite"
)

func newTestStore(t *testing.T) *SQLiteStore {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	s := NewSQLiteStore(db)
	if err := s.Migrate(context.Background()); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestCreateAndList(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	m, err := s.Create(ctx, "Hello World")
	if err != nil {
		t.Fatal(err)
	}
	if m.Slug != "hello-world" {
		t.Fatalf("slug = %q", m.Slug)
	}
	list, err := s.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].Text != "Hello World" {
		t.Fatalf("list = %+v", list)
	}
}

func TestCreateRejectsEmpty(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.Create(context.Background(), "   "); err == nil {
		t.Fatal("expected error for empty text")
	}
}

// closedStore returns a store whose underlying DB has been closed, so every
// query surfaces a driver error — exercising the DB error branches.
func closedStore(t *testing.T) *SQLiteStore {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	return NewSQLiteStore(db)
}

func TestMigrateError(t *testing.T) {
	if err := closedStore(t).Migrate(context.Background()); err == nil {
		t.Fatal("expected migrate error on closed db")
	}
}

func TestCreateError(t *testing.T) {
	if _, err := closedStore(t).Create(context.Background(), "x"); err == nil {
		t.Fatal("expected create error on closed db")
	}
}

func TestListError(t *testing.T) {
	if _, err := closedStore(t).List(context.Background()); err == nil {
		t.Fatal("expected list error on closed db")
	}
}
