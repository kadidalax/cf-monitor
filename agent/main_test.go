package main

import "testing"

func withPingTargetPolicy(allowLocal bool, blockPrivate bool, fn func()) {
	previousAllowLocal := allowLocalPingTargets
	previousBlockPrivate := blockPrivatePingTargets
	allowLocalPingTargets = allowLocal
	blockPrivatePingTargets = blockPrivate
	defer func() {
		allowLocalPingTargets = previousAllowLocal
		blockPrivatePingTargets = previousBlockPrivate
	}()
	fn()
}

func TestValidatePingTargetBlocksLocalTargetsByDefault(t *testing.T) {
	withPingTargetPolicy(false, false, func() {
		if err := validatePingTarget("127.0.0.1"); err == nil {
			t.Fatal("expected loopback target to be blocked")
		}
		if err := validatePingTarget("169.254.169.254"); err == nil {
			t.Fatal("expected link-local metadata target to be blocked")
		}
	})
}

func TestValidatePingTargetAllowsPrivateTargetsByDefault(t *testing.T) {
	withPingTargetPolicy(false, false, func() {
		if err := validatePingTarget("10.0.0.1"); err != nil {
			t.Fatalf("expected RFC1918 target to be allowed by default: %v", err)
		}
	})
}

func TestValidatePingTargetCanBlockPrivateTargets(t *testing.T) {
	withPingTargetPolicy(false, true, func() {
		if err := validatePingTarget("192.168.1.1"); err == nil {
			t.Fatal("expected RFC1918 target to be blocked when strict private blocking is enabled")
		}
	})
}

func TestValidatePingTargetCanAllowLocalTargets(t *testing.T) {
	withPingTargetPolicy(true, false, func() {
		if err := validatePingTarget("127.0.0.1"); err != nil {
			t.Fatalf("expected local target to be allowed after explicit opt-in: %v", err)
		}
	})
}

func TestPingTargetHostParsesURLsAndHostPorts(t *testing.T) {
	tests := map[string]string{
		"https://example.com:8443/path?q=1": "example.com",
		"example.com:443":                  "example.com",
		"[2001:db8::1]:443":                "2001:db8::1",
	}

	for input, expected := range tests {
		host, err := pingTargetHost(input)
		if err != nil {
			t.Fatalf("pingTargetHost(%q) returned error: %v", input, err)
		}
		if host != expected {
			t.Fatalf("pingTargetHost(%q) = %q, expected %q", input, host, expected)
		}
	}
}

func TestPingTargetHostRejectsEmptyOrOptionLikeTargets(t *testing.T) {
	for _, input := range []string{"", "-n 1 127.0.0.1"} {
		if _, err := pingTargetHost(input); err == nil {
			t.Fatalf("expected %q to be rejected", input)
		}
	}
}
