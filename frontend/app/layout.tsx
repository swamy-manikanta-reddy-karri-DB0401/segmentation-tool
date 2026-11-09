import "./globals.css";
import Sidebar from "@/components/Sidebar";

export const metadata = { title: "Segmentation Tool" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <Sidebar />
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
