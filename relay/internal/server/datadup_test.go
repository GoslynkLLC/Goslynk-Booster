package server

import (
	"net"
	"net/netip"
	"testing"
	"time"

	"github.com/gamepingbooster/relay/internal/protocol"
)

// movesAddress sends pkt from a fresh socket and reports whether the session's return address
// followed it - forwardUp moves it only once every check, the duplicate filter included, passed.
func movesAddress(t *testing.T, s *Server, sess *session, pkt []byte) bool {
	t.Helper()
	probe, err := net.DialUDP("udp4", nil, s.conn.LocalAddr().(*net.UDPAddr))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer probe.Close()
	want, err := netip.ParseAddrPort(probe.LocalAddr().String())
	if err != nil {
		t.Fatalf("parse local address: %v", err)
	}
	if _, err := probe.Write(pkt); err != nil {
		t.Fatalf("send: %v", err)
	}
	for i := 0; i < 40; i++ {
		if cur := sess.addr.Load(); cur != nil && *cur == want {
			return true
		}
		time.Sleep(5 * time.Millisecond)
	}
	return false
}

func TestHelloIsEchoedAndSwitchesTheSession(t *testing.T) {
	s, c := newTestRelay(t)
	res := handshake(t, c, clientID(40))
	sess := sessionOf(t, s, res)

	if _, err := c.Write(protocol.BuildHello(res.Session)); err != nil {
		t.Fatalf("send: %v", err)
	}
	reply := recvPacket(t, c)
	if v, ty := protocol.ParseHeader(reply[0]); v != protocol.Version || ty != protocol.TypeHello {
		t.Fatalf("expected a Hello back, got version %d type %#x", v, ty)
	}
	if sid, _ := protocol.DecodeSessionID(reply); sid != res.Session {
		t.Error("the Hello echo names another session")
	}
	if !sess.dup.Load() {
		t.Error("the session was not switched to DataDup")
	}
}

// Hello carries no signature; a stranger holding a session id must not double its downlink.
func TestHelloFromAnotherAddressIsIgnored(t *testing.T) {
	s, c := newTestRelay(t)
	res := handshake(t, c, clientID(41))
	sess := sessionOf(t, s, res)

	other, err := net.DialUDP("udp4", nil, s.conn.LocalAddr().(*net.UDPAddr))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer other.Close()
	if _, err := other.Write(protocol.BuildHello(res.Session)); err != nil {
		t.Fatalf("send: %v", err)
	}
	expectSilence(t, other)
	if sess.dup.Load() {
		t.Error("a Hello from an unrelated address switched the session")
	}
}

func TestSecondDataDupCopyIsDropped(t *testing.T) {
	s, c := newTestRelay(t)
	res := handshake(t, c, clientID(42))
	sess := sessionOf(t, s, res)
	inner := ipv4Packet(res.ClientIP, netip.MustParseAddr("1.1.1.1"))
	buf := make([]byte, protocol.MaxPacketLen)

	pkt := append([]byte(nil), protocol.EncodeDataDup(buf, res.Session, 7, inner)...)
	if !movesAddress(t, s, sess, pkt) {
		t.Fatal("the first copy was not accepted")
	}
	if movesAddress(t, s, sess, pkt) {
		t.Fatal("the second copy was accepted too")
	}
	if s.stats.duplicates.Load() != 1 {
		t.Errorf("duplicates = %d, want 1", s.stats.duplicates.Load())
	}
	next := protocol.EncodeDataDup(buf, res.Session, 8, inner)
	if !movesAddress(t, s, sess, next) {
		t.Error("the next sequence number was not accepted")
	}
}

// A forged copy must not mark a sequence number as seen and get the real packet dropped.
func TestForgedDataDupDoesNotConsumeASequenceNumber(t *testing.T) {
	s, c := newTestRelay(t)
	res := handshake(t, c, clientID(43))
	sess := sessionOf(t, s, res)
	buf := make([]byte, protocol.MaxPacketLen)

	forged := ipv4Packet(netip.MustParseAddr("10.77.0.200"), netip.MustParseAddr("1.1.1.1"))
	if movesAddress(t, s, sess, protocol.EncodeDataDup(buf, res.Session, 5, forged)) {
		t.Fatal("a packet with a forged inner source was accepted")
	}
	real := ipv4Packet(res.ClientIP, netip.MustParseAddr("1.1.1.1"))
	if !movesAddress(t, s, sess, protocol.EncodeDataDup(buf, res.Session, 5, real)) {
		t.Fatal("the real packet was dropped as a duplicate of the forged one")
	}
}

// A reconnecting client numbers from the start again and has to say Hello again.
func TestResumedSessionForgetsDataDupState(t *testing.T) {
	s, c := newTestRelay(t)
	res := handshake(t, c, clientID(44))
	sess := sessionOf(t, s, res)
	inner := ipv4Packet(res.ClientIP, netip.MustParseAddr("1.1.1.1"))
	buf := make([]byte, protocol.MaxPacketLen)

	if _, err := c.Write(protocol.BuildHello(res.Session)); err != nil {
		t.Fatalf("send: %v", err)
	}
	recvPacket(t, c)
	if !movesAddress(t, s, sess, protocol.EncodeDataDup(buf, res.Session, 5000, inner)) {
		t.Fatal("DataDup was not accepted")
	}

	again := handshake(t, c, clientID(44))
	if again.Session != res.Session {
		t.Fatal("the reconnect did not resume the session")
	}
	if sess.dup.Load() {
		t.Error("the resumed session still sends DataDup before any Hello")
	}
	if !movesAddress(t, s, sess, protocol.EncodeDataDup(buf, res.Session, 1, inner)) {
		t.Error("the new client's first packet was dropped as stale")
	}
}
