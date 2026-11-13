import Link from "next/link";
import { t } from "dicto";
import { Locale } from "dicto/react";
import { locales } from "@/locales";
import { locale } from "./locale";

export function generateStaticParams() {
  return locales.map((lang) => ({ lang }));
}

export default async function Layout({ children }: LayoutProps<"/[lang]">) {
  const lang = await locale();
  return (
    <html lang={lang}>
      <body style={{ fontFamily: "system-ui", maxWidth: 640, margin: "40px auto" }}>
        <nav style={{ display: "flex", gap: 16 }}>
          <Link href={`/${lang}`}>{t("Home")}</Link>
          <Link href={`/${lang}/about`}>{t("About")}</Link>
          {locales.map((other) => (
            <Link key={other} href={`/${other}`}>
              {other}
            </Link>
          ))}
        </nav>
        <Locale>{children}</Locale>
      </body>
    </html>
  );
}
