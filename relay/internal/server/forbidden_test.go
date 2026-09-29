package server

import (
	"net/netip"
	"testing"
)

func TestIsForbiddenDst(t *testing.T) {
	s := &Server{cfg: Config{Subnet: netip.MustParsePrefix("10.77.0.0/24")}}
	s.relayIP = netip.MustParseAddr("10.77.0.1")

	cases := map[string]bool{
		"10.77.0.1":       false, // the relay itself
		"10.77.0.2":       true,  // another client
		"8.8.8.8":         false,
		"103.82.24.7":     false,
		"10.0.0.5":        true,
		"192.168.1.1":     true,
		"172.16.0.1":      true,
		"127.0.0.1":       true,
		"169.254.169.254": true,
		"100.64.0.1":      true,
		"100.127.255.255": true,
		"100.128.0.1":     false,
		"0.1.2.3":         true,
		"240.0.0.1":       true,
		"255.255.255.255": true,
		"224.0.0.1":       true,
	}
	for ip, want := range cases {
		if got := s.isForbiddenDst(netip.MustParseAddr(ip)); got != want {
			t.Errorf("isForbiddenDst(%s) = %v, want %v", ip, got, want)
		}
	}
}
