package blob

import (
	"context"
	"errors"
	"sync"
)

// ErrNotFound is returned by Get when the key is absent.
var ErrNotFound = errors.New("blob not found")

// Blob is the object-storage port. The Memory impl is used now; an R2/S3 impl
// lands when R2 is enabled (needs a payment method) — same interface, swapped
// in main.
type Blob interface {
	Put(ctx context.Context, key string, data []byte) error
	Get(ctx context.Context, key string) ([]byte, error)
}

// Memory is an in-memory, concurrency-safe Blob implementation.
type Memory struct {
	mu sync.RWMutex
	m  map[string][]byte
}

// NewMemory returns an empty in-memory Blob store.
func NewMemory() *Memory { return &Memory{m: map[string][]byte{}} }

// Put stores a copy of data under key.
func (s *Memory) Put(_ context.Context, key string, data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := make([]byte, len(data))
	copy(cp, data)
	s.m[key] = cp
	return nil
}

// Get returns the bytes stored under key, or ErrNotFound.
func (s *Memory) Get(_ context.Context, key string) ([]byte, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	v, ok := s.m[key]
	if !ok {
		return nil, ErrNotFound
	}
	return v, nil
}
