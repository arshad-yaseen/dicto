import dicto from "dicto/next";

export default dicto({
  redirects: async () => [{ source: "/", destination: "/en", permanent: false }],
});
