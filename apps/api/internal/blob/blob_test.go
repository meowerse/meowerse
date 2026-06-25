package blob

import (
	"context"
	"testing"
)

func TestPutGet(t *testing.T) {
	s := NewMemory()
	ctx := context.Background()
	if err := s.Put(ctx, "k", []byte("v")); err != nil {
		t.Fatal(err)
	}
	got, err := s.Get(ctx, "k")
	if err != nil || string(got) != "v" {
		t.Fatalf("got=%q err=%v", got, err)
	}
}

func TestGetMissing(t *testing.T) {
	if _, err := NewMemory().Get(context.Background(), "nope"); err != ErrNotFound {
		t.Fatalf("err=%v", err)
	}
}
