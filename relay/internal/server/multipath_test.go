package server

import (
	"net"
	"net/netip"
	"testing"
	"time"

	"github.com/gamepingbooster/relay/internal/protocol"
)

func dialRelay(t *testing.T, s *Server) (*net.UDPConn, netip.AddrPort) {
	t.Helper()
	c, err := net.DialUDP("udp4", nil, s.conn.LocalAddr().(*net.UDPAddr))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { c.Close() })
	addr, err := netip.ParseAddrPort(c.LocalAddr().String())
	if err != nil {
		t.Fatalf("parse local address: %v", err)
	}
	return c, addr
}

func addrOf(t *testing.T, c *net.UDPConn) netip.AddrPort {
	t.Helper()
	addr, err := netip.ParseAddrPort(c.LocalAddr().String())
	if err != nil {
		t.Fatalf("parse local address: %v", err)
	}
	return addr
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	for i := 0; i < 60; i++ {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// multipathSession hands back a session that has said Hello and Multipath from c.
func multipathSession(t *testing.T, s *Server, c *net.UDPConn, id byte) (*session, protocol.HandshakeResult) {
	t.Helper()
	res := handshake(t, c, clientID(id))
	sess := sessionOf(t, s, res)
	if _, err := c.Write(protocol.BuildHello(res.Session)); err != nil {
		t.Fatalf("send: %v", err)
	}
	recvPacket(t, c)
	if _, err := c.Write(protocol.BuildMultipath(res.Session)); err != nil {
		t.Fatalf("send: %v", err)
	}
	reply := recvPacket(t, c)
	if _, ty := protocol.ParseHeader(reply[0]); ty != protocol.TypeMultipath {
		t.Fatalf("expected a Multipath echo, got type %#x", ty)
	}
	if !sess.multi.Load() {
		t.Fatal("the session was not switched to multipath")
	}
	return sess, res
}

func TestMultipathNeedsHelloFirst(t *testing.T) {
	s, c := newTestRelay(t)
	res := handshake(t, c, clientID(60))
	sess := sessionOf(t, s, res)
	if _, err := c.Write(protocol.BuildMultipath(res.Session)); err != nil {
		t.Fatalf("send: %v", err)
	}
	expectSilence(t, c)
	if sess.multi.Load() {
		t.Error("multipath was switched on before DataDup")
	}
}

func TestMultipathFromAnotherAddressIsIgnored(t *testing.T) {
	s, c := newTestRelay(t)
	res := handshake(t, c, clientID(61))
	sess := sessionOf(t, s, res)
	if _, err := c.Write(protocol.BuildHello(res.Session)); err != nil {
		t.Fatalf("send: %v", err)
	}
	recvPacket(t, c)
	other, _ := dialRelay(t, s)
	if _, err := other.Write(protocol.BuildMultipath(res.Session)); err != nil {
		t.Fatalf("send: %v", err)
	}
	expectSilence(t, other)
	if sess.multi.Load() {
		t.Error("a stranger switched the session to multipath")
	}
}

// The second road is added beside the first, and both downlink copies stop sharing one address.
func TestSecondPathIsAddedNotRoamed(t *testing.T) {
	s, c := newTestRelay(t)
	sess, res := multipathSession(t, s, c, 62)
	primary := addrOf(t, c)
	buf := make([]byte, protocol.MaxPacketLen)
	inner := ipv4Packet(res.ClientIP, netip.MustParseAddr("1.1.1.1"))

	entry, entryAddr := dialRelay(t, s)
	if _, err := entry.Write(protocol.EncodeDataDup(buf, res.Session, 1, inner)); err != nil {
		t.Fatalf("send: %v", err)
	}
	waitFor(t, "the second path", func() bool {
		alt := sess.alt.Load()
		return alt != nil && *alt == entryAddr
	})
	if cur := *sess.addr.Load(); cur != primary {
		t.Errorf("the first path moved to %v", cur)
	}
	first, second, ok := sess.downTargets(time.Now().UnixNano())
	if !ok || first != primary || second != entryAddr {
		t.Errorf("downlink goes to %v and %v, want %v and %v", first, second, primary, entryAddr)
	}

	// The copy that loses the race on the first road still proves that road is alive.
	before := sess.addrSeen.Load()
	time.Sleep(2 * time.Millisecond)
	if _, err := c.Write(protocol.EncodeDataDup(buf, res.Session, 1, inner)); err != nil {
		t.Fatalf("send: %v", err)
	}
	waitFor(t, "the duplicate to refresh the first path", func() bool { return sess.addrSeen.Load() > before })
}

func TestForgedPacketDoesNotAddAPath(t *testing.T) {
	s, c := newTestRelay(t)
	sess, res := multipathSession(t, s, c, 66)
	buf := make([]byte, protocol.MaxPacketLen)
	forged := ipv4Packet(netip.MustParseAddr("10.77.0.200"), netip.MustParseAddr("1.1.1.1"))
	other, _ := dialRelay(t, s)
	if _, err := other.Write(protocol.EncodeDataDup(buf, res.Session, 1, forged)); err != nil {
		t.Fatalf("send: %v", err)
	}
	time.Sleep(50 * time.Millisecond)
	if sess.alt.Load() != nil {
		t.Error("a packet with a forged inner source added a path")
	}
}

func TestPingOnEitherPathKeepsBoth(t *testing.T) {
	s, c := newTestRelay(t)
	sess, res := multipathSession(t, s, c, 63)
	primary := addrOf(t, c)
	entry, entryAddr := dialRelay(t, s)

	if _, err := entry.Write(protocol.BuildPing(res.Session, 1)); err != nil {
		t.Fatalf("send: %v", err)
	}
	recvPacket(t, entry)
	if _, err := c.Write(protocol.BuildPing(res.Session, 2)); err != nil {
		t.Fatalf("send: %v", err)
	}
	recvPacket(t, c)
	if *sess.addr.Load() != primary {
		t.Error("the first path was replaced")
	}
	if alt := sess.alt.Load(); alt == nil || *alt != entryAddr {
		t.Error("the second path was not kept")
	}
}

// A silent road stops getting copies, and a third address replaces the one that went quiet.
func TestStalePathIsDroppedAndReplaced(t *testing.T) {
	a := netip.MustParseAddrPort("192.0.2.1:1000")
	b := netip.MustParseAddrPort("192.0.2.2:1000")
	c := netip.MustParseAddrPort("192.0.2.3:1000")
	var sess session
	sess.addr.Store(&a)
	sess.multi.Store(true)

	now := time.Now().UnixNano()
	sess.addrSeen.Store(now)
	if !sess.notePath(b, now) {
		t.Fatal("the second path was not added")
	}
	later := now + int64(pathStale) + int64(time.Second)
	sess.notePath(b, later)
	first, second, _ := sess.downTargets(later)
	if first != b || second != b {
		t.Errorf("with the first path silent the downlink went to %v and %v, want both to %v", first, second, b)
	}

	if !sess.notePath(c, later) {
		t.Fatal("the third address was not taken")
	}
	if *sess.addr.Load() != c {
		t.Errorf("the silent path %v was kept over the live one", *sess.addr.Load())
	}
	if *sess.alt.Load() != b {
		t.Error("the live path was displaced")
	}
}

func TestSinglePathStillSendsBothCopiesToOneAddress(t *testing.T) {
	a := netip.MustParseAddrPort("192.0.2.1:1000")
	var sess session
	sess.addr.Store(&a)
	sess.addrSeen.Store(time.Now().UnixNano())
	first, second, ok := sess.downTargets(time.Now().UnixNano())
	if !ok || first != a || second != a {
		t.Errorf("got %v and %v, want both to %v", first, second, a)
	}
}

func TestDisconnectAcceptedFromTheSecondPath(t *testing.T) {
	s, c := newTestRelay(t)
	sess, res := multipathSession(t, s, c, 64)
	entry, _ := dialRelay(t, s)
	if _, err := entry.Write(protocol.BuildPing(res.Session, 1)); err != nil {
		t.Fatalf("send: %v", err)
	}
	recvPacket(t, entry)
	if _, err := entry.Write(protocol.BuildDisconnect(res.Session)); err != nil {
		t.Fatalf("send: %v", err)
	}
	waitFor(t, "the session to end", func() bool { return s.lookup(sess.id) == nil })
}

func TestResumedSessionForgetsMultipath(t *testing.T) {
	s, c := newTestRelay(t)
	sess, res := multipathSession(t, s, c, 65)
	entry, _ := dialRelay(t, s)
	if _, err := entry.Write(protocol.BuildPing(res.Session, 1)); err != nil {
		t.Fatalf("send: %v", err)
	}
	recvPacket(t, entry)

	again := handshake(t, c, clientID(65))
	if again.Session != res.Session {
		t.Fatal("the reconnect did not resume the session")
	}
	if sess.multi.Load() || sess.alt.Load() != nil {
		t.Error("the resumed session kept its old second path")
	}
}
