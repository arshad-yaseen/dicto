import { notFound } from "next/navigation";
import { lang } from "next/root-params";
import { isLocale, setLocale } from "@/locales";

export async function locale() {
  const locale = await lang();
  if (!isLocale(locale)) notFound();
  await setLocale(locale);
  return locale;
}
