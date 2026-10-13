package e2ee

import (
	"crypto/sha256"
	"fmt"
	"sort"
	"strings"
)

// SecurityCode computes the 60-digit code people compare in person for a set
// of device keys (PROTOCOL.md §3). The order of keys does not matter.
func SecurityCode(keys []PublicJWK) (string, error) {
	digests := make([]string, 0, len(keys))
	for _, k := range keys {
		x, y, err := k.rawXY()
		if err != nil {
			return "", err
		}
		d := sha256.Sum256(append(append(make([]byte, 0, 64), x...), y...))
		digests = append(digests, B64u(d[:]))
	}
	sort.Strings(digests)
	h := sha256.Sum256([]byte(strings.Join(digests, "")))
	groups := make([]string, 12)
	for i := range groups {
		n := (int(h[2*i])<<16 | int(h[2*i+1])<<8 | int(h[24+i%8])) % 100000
		groups[i] = fmt.Sprintf("%05d", n)
	}
	return strings.Join(groups, " "), nil
}
