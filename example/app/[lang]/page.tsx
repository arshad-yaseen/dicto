import Link from "next/link";
import { t } from "dicto";
import { Counter } from "./counter";
import { locale } from "./locale";

export default async function Home() {
  const lang = await locale();
  return (
    <main>
      <h1>{t("Hello, {name}!", { name: "Ada" })}</h1>
      <p>{t("This text is rendered on the server.")}</p>
      <p>
        {t("Read more on the <link>about page</link>.", {
          link: (text) => <Link href={`/${lang}/about`}>{text}</Link>,
        })}
      </p>
      <Counter />
    </main>
  );
}
