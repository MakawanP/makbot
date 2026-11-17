import "./globals.css";

export const metadata = {
  title: "Makbot",
  description: "A chat assistant powered by DeepSeek",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
