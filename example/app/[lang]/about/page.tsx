import { t } from "dicto";
import { locale } from "../locale";

export default async function About() {
  await locale();
  return (
    <main>
      <h1>{t("About")}</h1>
      <p>{t("Plain text can use | and // freely.")}</p>
    </main>
  );
}
