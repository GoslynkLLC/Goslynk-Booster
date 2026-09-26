package protocol

import (
	"bytes"
	"testing"
)

func TestDataDupRoundTrip(t *testing.T) {
	sid := SessionID{9, 8, 7, 6, 5, 4, 3, 2}
	ip := []byte{0x45, 0, 0, 20, 1, 2, 3, 4, 64, 17, 0, 0, 10, 77, 0, 2, 1, 1, 1, 1}
	buf := make([]byte, MaxPacketLen)

	pkt := EncodeDataDup(buf, sid, 0xdeadbeef, ip)
	if len(pkt) != DataDupHeaderLen+len(ip) {
		t.Fatalf("encoded %d bytes, want %d", len(pkt), DataDupHeaderLen+len(ip))
	}
	if v, ty := ParseHeader(pkt[0]); v != Version || ty != TypeDataDup {
		t.Fatalf("header is version %d type %#x", v, ty)
	}
	gotSid, seq, payload, err := DecodeDataDup(pkt)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if gotSid != sid || seq != 0xdeadbeef || !bytes.Equal(payload, ip) {
		t.Fatalf("round trip gave sid %v seq %#x payload %v", gotSid, seq, payload)
	}

	if _, _, _, err := DecodeDataDup(pkt[:DataDupHeaderLen]); err != ErrShortPacket {
		t.Errorf("header-only packet: err %v, want ErrShortPacket", err)
	}
	pkt[DataDupHeaderLen] = 0x60
	if _, _, _, err := DecodeDataDup(pkt); err != ErrNotIPv4 {
		t.Errorf("IPv6 payload: err %v, want ErrNotIPv4", err)
	}
}

func TestDupFilter(t *testing.T) {
	var f DupFilter
	steps := []struct {
		seq   uint32
		fresh bool
	}{
		{10, true},
		{10, false}, // the second copy
		{12, true},
		{11, true}, // reordered, still inside the window
		{11, false},
		{12, false},
		{12 + 63, true},
		{12, false}, // 63 behind: the oldest number still remembered
		{13, true},  // 62 behind and never seen
		{11, false}, // 64 behind: too old, dropped unseen
		{200, true}, // a jump wider than the window resets it
		{199, true},
		{200, false},
	}
	for i, s := range steps {
		if got := f.Fresh(s.seq); got != s.fresh {
			t.Fatalf("step %d: Fresh(%d) = %v, want %v", i, s.seq, got, s.fresh)
		}
	}
}

func TestDupFilterWraps(t *testing.T) {
	var f DupFilter
	for _, seq := range []uint32{0xfffffffe, 0xffffffff, 0, 1} {
		if !f.Fresh(seq) {
			t.Fatalf("Fresh(%#x) = false across the wrap", seq)
		}
	}
	if f.Fresh(0xffffffff) {
		t.Fatal("a copy from before the wrap was taken as new")
	}
}
