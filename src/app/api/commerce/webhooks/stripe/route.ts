import Stripe from "stripe";
import { db } from "@/lib/db";
import {
  boundedBody,
  commerceJson,
  commerceError,
} from "@/modules/commerce/http";
import { createPaymentService } from "@/modules/commerce/payments";
import { stripeProvider } from "@/modules/commerce/stripe";
import { configuredCustomerMail } from "@/modules/customer-email/resend";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const signature = request.headers.get("stripe-signature");
    if (!signature)
      return commerceJson({ error: { code: "INVALID_SIGNATURE" } }, 400);
    await createPaymentService(db, stripeProvider(), configuredCustomerMail()).webhook(
      await boundedBody(request, 262144),
      signature,
    );
    return commerceJson({ received: true });
  } catch (error) {
    if (error instanceof Stripe.errors.StripeSignatureVerificationError)
      return commerceJson({ error: { code: "INVALID_SIGNATURE" } }, 400);
    return commerceError(error);
  }
}
