// Package slug provides URL-safe slug generation.
package slug

import (
	"regexp"
	"strings"
)

var nonAlphanumeric = regexp.MustCompile(`[^a-z0-9]+`)

// Slugify converts an arbitrary string into a URL-safe slug.
//
// It lowercases the input, replaces any run of non-alphanumeric characters
// with a single "-", and trims leading/trailing "-".
func Slugify(input string) string {
	lowered := strings.ToLower(input)
	replaced := nonAlphanumeric.ReplaceAllString(lowered, "-")
	return strings.Trim(replaced, "-")
}
