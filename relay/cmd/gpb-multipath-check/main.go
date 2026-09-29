// Command gpb-multipath-check drives one real multipath session against a live relay and reports
// whether the relay behaves as docs/PROTOCOL-v3.md says: both roads carry a copy of every packet,
// the client keeps exactly one, and a road that goes silent is dropped after 3 seconds.
//
// Like gpb-soak it pings the relay's own inner address, so nothing leaves the VPS.
//
// Usage:
//
//	gpb-multipath-check -relay 203.0.113.10:51820 -entry 198.51.100.7:51821 -psk-file ./psk
//
// Without -entry the second road is a second socket straight to the relay, which still exercises
// the relay's two-address table but not the forwarder.
package main

import (
	"encoding/binary"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/netip"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gamepingbooster/relay/internal/protocol"
)

const (
	echoID    = 0x4d50
	pathStale = 3 * time.Second
)

type road struct {
	name   string
	conn   *net.UDPConn
	copies atomic.Uint64
	pongs  atomic.Uint64
}

type counts struct {
	mu      sync.Mutex
	seen    map[uint32]int
	unique  uint64
	extra   uint64
	control map[byte]bool
}

func main() {
	relayAddr := flag.String("relay", "", "exit relay endpoint, ip:port (required)")
	entryAddr := flag.String("entry", "", "entry forwarder endpoint for the second road (default: the relay again)")
	pskFile := flag.String("psk-file", "", "file holding the pre-shared key (or set GPB_PSK)")
	pps := flag.Int("pps", 50, "echo requests per second")
	phase := flag.Duration("phase", 8*time.Second, "length of each phase: both roads, then the main road only")
	flag.Parse()

	relay, err := netip.ParseAddrPort(*relayAddr)
	if err != nil {
		fatal("-relay: " + err.Error())
	}
	second := relay
	if *entryAddr != "" {
		if second, err = netip.ParseAddrPort(*entryAddr); err != nil {
			fatal("-entry: " + err.Error())
		}
	}
	psk, err := loadPSK(*pskFile)
	if err != nil {
		fatal(err.Error())
	}

	mainConn, res, err := handshake(relay, psk)
	if err != nil {
		fatal("handshake: " + err.Error())
	}
	altConn, err := net.DialUDP("udp4", nil, net.UDPAddrFromAddrPort(second))
	if err != nil {
		fatal("second road: " + err.Error())
	}
	main := &road{name: "main", conn: mainConn}
	alt := &road{name: "second", conn: altConn}
	sid := res.Session
	defer func() { _, _ = mainConn.Write(protocol.BuildDisconnect(sid)) }()

	c := &counts{seen: map[uint32]int{}, control: map[byte]bool{}}
	stop := make(chan struct{})
	for _, r := range []*road{main, alt} {
		go c.read(r, sid, res.ClientIP, stop)
	}

	if !c.await(mainConn, protocol.BuildHello(sid), protocol.TypeHello) {
		fatal("the relay never echoed Hello: it predates DataDup")
	}
	if !c.await(mainConn, protocol.BuildMultipath(sid), protocol.TypeMultipath) {
		fatal("the relay never echoed Multipath: it predates multipath, deploy the new relayd")
	}
	fmt.Printf("session up: inner %s, Hello and Multipath echoed\n", res.ClientIP)

	var seq atomic.Uint32
	send := func(roads []*road, n int) {
		tick := time.NewTicker(time.Second / time.Duration(*pps))
		defer tick.Stop()
		ping := time.NewTicker(time.Second)
		defer ping.Stop()
		wire := make([]byte, protocol.MaxPacketLen)
		for _, r := range roads {
			_, _ = r.conn.Write(protocol.BuildPing(sid, uint64(time.Now().UnixNano())))
		}
		for sent := 0; sent < n; {
			select {
			case <-ping.C:
				for _, r := range roads {
					_, _ = r.conn.Write(protocol.BuildPing(sid, uint64(time.Now().UnixNano())))
				}
			case <-tick.C:
				s := seq.Add(1)
				inner := buildEchoRequest(res.ClientIP, res.RelayIP, uint16(s), 32)
				out := protocol.EncodeDataDup(wire, sid, s, inner)
				_, _ = roads[0].conn.Write(out)
				_, _ = roads[len(roads)-1].conn.Write(out)
				sent++
			}
		}
	}

	perPhase := int(phase.Seconds() * float64(*pps))
	ok := true

	snap := c.snapshot(main, alt)
	send([]*road{main, alt}, perPhase)
	time.Sleep(500 * time.Millisecond)
	both := c.snapshot(main, alt).minus(snap)
	fmt.Printf("both roads:  sent %d, got %d (loss %.1f%%), copies main %d / second %d, dropped duplicates %d\n",
		perPhase, both.unique, loss(perPhase, both.unique), both.main, both.alt, both.extra)
	if both.alt == 0 {
		fmt.Println("  FAIL: nothing came back on the second road")
		ok = false
	}
	if both.main == 0 {
		fmt.Println("  FAIL: nothing came back on the main road")
		ok = false
	}

	// The second road goes quiet; after pathStale the relay must send both copies to the main one.
	send([]*road{main}, int((pathStale+time.Second).Seconds()*float64(*pps)))
	snap = c.snapshot(main, alt)
	send([]*road{main}, perPhase)
	time.Sleep(500 * time.Millisecond)
	one := c.snapshot(main, alt).minus(snap)
	fmt.Printf("main only:   sent %d, got %d (loss %.1f%%), copies main %d / second %d (measured after %s of silence)\n",
		perPhase, one.unique, loss(perPhase, one.unique), one.main, one.alt, pathStale+time.Second)
	if one.alt != 0 || one.main < 2*one.unique*9/10 {
		fmt.Println("  FAIL: the main road is not getting both copies once the second road is stale")
		ok = false
	}

	close(stop)
	if !ok {
		os.Exit(1)
	}
	fmt.Println("PASS")
}

// await sends pkt once a second until the relay echoes a packet of type want.
func (c *counts) await(conn *net.UDPConn, pkt []byte, want byte) bool {
	for i := 0; i < 5; i++ {
		_, _ = conn.Write(pkt)
		deadline := time.Now().Add(time.Second)
		for time.Now().Before(deadline) {
			c.mu.Lock()
			got := c.control[want]
			c.mu.Unlock()
			if got {
				return true
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	return false
}

func (c *counts) read(r *road, sid protocol.SessionID, inner netip.Addr, stop <-chan struct{}) {
	buf := make([]byte, protocol.MaxPacketLen)
	for {
		select {
		case <-stop:
			return
		default:
		}
		_ = r.conn.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
		n, err := r.conn.Read(buf)
		if err != nil || n < 1 {
			continue
		}
		version, t := protocol.ParseHeader(buf[0])
		if version != protocol.Version {
			continue
		}
		switch t {
		case protocol.TypePong:
			r.pongs.Add(1)
		case protocol.TypeHello, protocol.TypeMultipath:
			c.mu.Lock()
			c.control[t] = true
			c.mu.Unlock()
		case protocol.TypeDataDup:
			got, seq, ip, err := protocol.DecodeDataDup(buf[:n])
			if err != nil || got != sid {
				continue
			}
			if dst, ok := protocol.DstIPv4(ip); !ok || dst != inner {
				continue
			}
			r.copies.Add(1)
			c.mu.Lock()
			c.seen[seq]++
			if c.seen[seq] == 1 {
				c.unique++
			} else {
				c.extra++
			}
			c.mu.Unlock()
		}
	}
}

type snapshot struct{ unique, extra, main, alt uint64 }

func (c *counts) snapshot(main, alt *road) snapshot {
	c.mu.Lock()
	defer c.mu.Unlock()
	return snapshot{c.unique, c.extra, main.copies.Load(), alt.copies.Load()}
}

func (s snapshot) minus(o snapshot) snapshot {
	return snapshot{s.unique - o.unique, s.extra - o.extra, s.main - o.main, s.alt - o.alt}
}

func loss(sent int, got uint64) float64 {
	if sent == 0 {
		return 0
	}
	return 100 * float64(uint64(sent)-min(got, uint64(sent))) / float64(sent)
}

func handshake(relay netip.AddrPort, psk []byte) (*net.UDPConn, protocol.HandshakeResult, error) {
	var zero protocol.HandshakeResult
	conn, err := net.DialUDP("udp4", nil, net.UDPAddrFromAddrPort(relay))
	if err != nil {
		return nil, zero, err
	}
	var id protocol.ClientID
	binary.BigEndian.PutUint64(id[:], 0x4d50000000000000|uint64(time.Now().UnixNano()&0xffffffff))
	var last error
	for attempt := 0; attempt < 4; attempt++ {
		req, nonce, err := protocol.BuildHandshakeReq(psk, id, time.Now())
		if err != nil {
			conn.Close()
			return nil, zero, err
		}
		if _, err := conn.Write(req); err != nil {
			conn.Close()
			return nil, zero, err
		}
		buf := make([]byte, protocol.MaxPacketLen)
		_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
		n, err := conn.Read(buf)
		if err != nil {
			last = err
			continue
		}
		res, err := protocol.ParseHandshakeResp(psk, buf[:n], nonce)
		if err != nil {
			last = err
			continue
		}
		if res.Status != protocol.StatusOK {
			conn.Close()
			return nil, zero, fmt.Errorf("refused with status %d", res.Status)
		}
		_ = conn.SetReadDeadline(time.Time{})
		return conn, res, nil
	}
	conn.Close()
	return nil, zero, fmt.Errorf("no usable answer after 4 attempts: %w", last)
}

func buildEchoRequest(src, dst netip.Addr, seq uint16, payload int) []byte {
	total := 20 + 8 + payload
	pkt := make([]byte, total)
	pkt[0] = 0x45
	binary.BigEndian.PutUint16(pkt[2:4], uint16(total))
	binary.BigEndian.PutUint16(pkt[4:6], seq)
	pkt[8] = 64
	pkt[9] = 1
	s, d := src.As4(), dst.As4()
	copy(pkt[12:16], s[:])
	copy(pkt[16:20], d[:])
	binary.BigEndian.PutUint16(pkt[10:12], checksum(pkt[:20]))
	icmp := pkt[20:]
	icmp[0] = 8
	binary.BigEndian.PutUint16(icmp[4:6], echoID)
	binary.BigEndian.PutUint16(icmp[6:8], seq)
	binary.BigEndian.PutUint16(icmp[2:4], checksum(icmp))
	return pkt
}

func checksum(b []byte) uint16 {
	var sum uint32
	for i := 0; i+1 < len(b); i += 2 {
		sum += uint32(b[i])<<8 | uint32(b[i+1])
	}
	if len(b)%2 == 1 {
		sum += uint32(b[len(b)-1]) << 8
	}
	for sum>>16 != 0 {
		sum = sum&0xffff + sum>>16
	}
	return ^uint16(sum)
}

func loadPSK(path string) ([]byte, error) {
	if path != "" {
		b, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", path, err)
		}
		return []byte(strings.TrimSpace(string(b))), nil
	}
	if env := strings.TrimSpace(os.Getenv("GPB_PSK")); env != "" {
		return []byte(env), nil
	}
	return nil, errors.New("no PSK: pass -psk-file or set GPB_PSK")
}

func fatal(msg string) {
	fmt.Fprintln(os.Stderr, "gpb-multipath-check: "+msg)
	os.Exit(2)
}
