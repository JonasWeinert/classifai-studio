// The bundled sample dataset (100 bank transactions labelled by category and "recurring"), for a
// zero-setup first run. Imported as text so it works in the app and the browser preview alike.
import transactionsCsv from "../../samples/transactions.csv?raw";

export const SAMPLE_DATASET = { name: "Sample · bank transactions", text: transactionsCsv };
