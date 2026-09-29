using System;
using System.IO;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;

namespace ScruffBridge
{
    /// <summary>
    /// A small WebSocket client (RFC 6455, text frames, ws:// only) over a plain TCP socket, since
    /// older Unity games run on .NET 3.5, which has none. Reading happens on one thread; Send can
    /// be called from any thread.
    /// </summary>
    public class WebSocketClient : IDisposable
    {
        readonly TcpClient tcp;
        readonly Stream stream;
        readonly object sendLock = new object();
        readonly Random random = new Random();
        bool closed;

        WebSocketClient(TcpClient tcp, Stream stream)
        {
            this.tcp = tcp;
            this.stream = stream;
        }

        /// <summary>Connects to ws://host:port/path and completes the handshake.</summary>
        public static WebSocketClient Connect(string url, int timeoutMs)
        {
            var uri = new Uri(url);
            if (uri.Scheme != "ws") throw new NotSupportedException("Only ws:// URLs are supported.");
            var tcp = new TcpClient();
            IAsyncResult pending = tcp.BeginConnect(uri.Host, uri.Port, null, null);
            if (!pending.AsyncWaitHandle.WaitOne(timeoutMs))
            {
                tcp.Close();
                throw new IOException("Timed out connecting to " + uri.Host + ":" + uri.Port);
            }
            tcp.EndConnect(pending);
            tcp.NoDelay = true;
            Stream stream = tcp.GetStream();

            var keyBytes = new byte[16];
            new Random().NextBytes(keyBytes);
            string key = Convert.ToBase64String(keyBytes);
            string request =
                "GET " + uri.PathAndQuery + " HTTP/1.1\r\n" +
                "Host: " + uri.Host + ":" + uri.Port + "\r\n" +
                "Upgrade: websocket\r\n" +
                "Connection: Upgrade\r\n" +
                "Sec-WebSocket-Key: " + key + "\r\n" +
                "Sec-WebSocket-Version: 13\r\n\r\n";
            byte[] req = Encoding.ASCII.GetBytes(request);
            stream.Write(req, 0, req.Length);

            string response = ReadHeaders(stream);
            if (!response.StartsWith("HTTP/1.1 101"))
            {
                tcp.Close();
                throw new IOException("The hub refused the connection: " + response.Split('\r')[0]);
            }
            string expected = Convert.ToBase64String(
                SHA1.Create().ComputeHash(Encoding.ASCII.GetBytes(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
            if (response.IndexOf(expected, StringComparison.Ordinal) < 0)
            {
                tcp.Close();
                throw new IOException("Bad WebSocket handshake.");
            }
            return new WebSocketClient(tcp, stream);
        }

        static string ReadHeaders(Stream stream)
        {
            var sb = new StringBuilder();
            while (sb.Length < 16384)
            {
                int b = stream.ReadByte();
                if (b < 0) throw new IOException("Connection closed during handshake.");
                sb.Append((char)b);
                if (sb.Length >= 4 && sb[sb.Length - 1] == '\n' && sb[sb.Length - 2] == '\r' && sb[sb.Length - 3] == '\n' && sb[sb.Length - 4] == '\r')
                    return sb.ToString();
            }
            throw new IOException("Handshake response too long.");
        }

        public void Send(string text)
        {
            SendFrame(0x1, Encoding.UTF8.GetBytes(text));
        }

        void SendFrame(int opcode, byte[] payload)
        {
            lock (sendLock)
            {
                if (closed) throw new IOException("The connection is closed.");
                var header = new MemoryStream();
                header.WriteByte((byte)(0x80 | opcode));
                long len = payload.Length;
                if (len < 126) header.WriteByte((byte)(0x80 | len));
                else if (len <= 0xFFFF)
                {
                    header.WriteByte(0x80 | 126);
                    header.WriteByte((byte)(len >> 8));
                    header.WriteByte((byte)len);
                }
                else
                {
                    header.WriteByte(0x80 | 127);
                    for (int i = 7; i >= 0; i--) header.WriteByte((byte)(len >> (8 * i)));
                }
                // Client frames must be masked.
                var mask = new byte[4];
                lock (random) random.NextBytes(mask);
                header.Write(mask, 0, 4);
                var masked = new byte[payload.Length];
                for (int i = 0; i < payload.Length; i++) masked[i] = (byte)(payload[i] ^ mask[i & 3]);
                byte[] h = header.ToArray();
                stream.Write(h, 0, h.Length);
                stream.Write(masked, 0, masked.Length);
                stream.Flush();
            }
        }

        /// <summary>Blocks until a whole text message arrives; null when the connection closes.</summary>
        public string Receive()
        {
            var message = new MemoryStream();
            while (true)
            {
                int b0 = stream.ReadByte();
                int b1 = stream.ReadByte();
                if (b0 < 0 || b1 < 0) return null;
                bool fin = (b0 & 0x80) != 0;
                int opcode = b0 & 0x0F;
                long len = b1 & 0x7F;
                if (len == 126)
                {
                    byte[] l = ReadExactly(2);
                    len = (l[0] << 8) | l[1];
                }
                else if (len == 127)
                {
                    byte[] l = ReadExactly(8);
                    len = 0;
                    for (int i = 0; i < 8; i++) len = (len << 8) | l[i];
                }
                byte[] mask = (b1 & 0x80) != 0 ? ReadExactly(4) : null;
                byte[] payload = ReadExactly((int)len);
                if (mask != null) for (int i = 0; i < payload.Length; i++) payload[i] ^= mask[i & 3];

                if (opcode == 0x8) return null; // close
                if (opcode == 0x9) { SendFrame(0xA, payload); continue; } // ping → pong
                if (opcode == 0xA) continue; // pong
                message.Write(payload, 0, payload.Length);
                if (fin) return Encoding.UTF8.GetString(message.ToArray());
            }
        }

        byte[] ReadExactly(int count)
        {
            var buf = new byte[count];
            int got = 0;
            while (got < count)
            {
                int n = stream.Read(buf, got, count - got);
                if (n <= 0) throw new IOException("Connection closed.");
                got += n;
            }
            return buf;
        }

        public void Dispose()
        {
            lock (sendLock)
            {
                if (closed) return;
                closed = true;
            }
            try { tcp.Close(); } catch { }
        }
    }
}
