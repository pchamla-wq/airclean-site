/* global location -- fourni par le navigateur. */
/**
 * RÉGLAGES de l'espace partenaire — le seul fichier à modifier pour publier la page.
 *
 * Il ne contient AUCUN secret : l'adresse du projet et sa clé PUBLIQUE (« publishable ») sont
 * les mêmes que celles embarquées dans les apps. N'y mettez JAMAIS la clé de service
 * (« service_role ») : la page refuse de démarrer si elle en voit une.
 *
 * Ouverte sur l'ordinateur du développeur (localhost), la page parle au serveur d'essai
 * (`pnpm local:backend`, port 54321) et non à la vraie base.
 */
globalThis.AIRCLEAN_PARTNER_CONFIG =
  location.hostname === "localhost" || location.hostname === "127.0.0.1"
    ? { supabaseUrl: "http://localhost:54321", publicKey: "local" }
    : { supabaseUrl: "https://ipwddkwtpcmieijhqpup.supabase.co", publicKey: "sb_publishable_EVfUxEFqn46zz1EKz5DlZQ_LxPZ1r82" };
