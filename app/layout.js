import "./globals.css";

export const metadata = {
  title: "Makbot",
  description: "A chat assistant powered by Google Gemini",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
