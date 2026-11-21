import { Router } from "express";
import { ObjectId } from "mongodb";
import Stripe from "stripe";
import { getCollections } from "../db.js";

const router = Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:3000";

function computeEndDate(startDateStr, rentalType, durationCount) {
  const [y, m, d] = String(startDateStr || "")
    .split("-")
    .map(Number);
  if (!y || !m || !d) return "";

  const date = new Date(Date.UTC(y, m - 1, d));
  if (rentalType === "Weekly") {
    date.setUTCDate(date.getUTCDate() + durationCount * 7);
  } else if (rentalType === "Monthly") {
    date.setUTCMonth(date.getUTCMonth() + durationCount);
  } else {
    date.setUTCDate(date.getUTCDate() + durationCount);
  }
  return date.toISOString().split("T")[0];
}

// POST /payments/create-checkout-session
router.post("/create-checkout-session", async (req, res) => {
  try {
    const {
      equipmentId,
      startDate,
      endDate,
      duration,
      quantity,
      contactNumber,
      deliveryAddress,
      additionalNotes,
      customerEmail,
      customerName,
    } = req.body;

    if (!equipmentId || !ObjectId.isValid(equipmentId) || !customerEmail) {
      return res
        .status(400)
        .json({ message: "Missing required booking fields" });
    }

    const dur = Math.max(1, Number(duration) || 1);
    const qty = Math.max(1, Number(quantity) || 1);

    const { equipment } = await getCollections();
    const item = await equipment.findOne({
      _id: new ObjectId(equipmentId),
      status: "approved",
    });

    if (!item) {
      return res.status(404).json({ message: "Equipment not found" });
    }
    if (item.availableQuantity < qty) {
      return res
        .status(400)
        .json({ message: `Only ${item.availableQuantity} units available` });
    }

    // Always compute total on the server
    const totalPrice = Number(item.price) * dur * qty;
    const resolvedEndDate =
      String(endDate || "").trim() ||
      computeEndDate(startDate, item.rentalType, dur);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: customerEmail,
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: item.name,
              description: `${qty} unit(s) × ${dur} ${item.rentalType} (${startDate} to ${resolvedEndDate})`,
            },
            unit_amount: Math.round(totalPrice * 100),
          },
          quantity: 1,
        },
      ],
      metadata: {
        equipmentId: item._id.toString(),
        equipmentName: String(item.name || "").slice(0, 200),
        ownerEmail: String(item.ownerEmail || "").slice(0, 150),
        rentalType: String(item.rentalType || ""),
        startDate: String(startDate || ""),
        endDate: resolvedEndDate,
        duration: String(dur),
        quantity: String(qty),
        contactNumber: String(contactNumber || "").slice(0, 100),
        deliveryAddress: String(deliveryAddress || "").slice(0, 300),
        additionalNotes: String(additionalNotes || "").slice(0, 450),
        totalPrice: String(totalPrice),
        customerEmail: String(customerEmail).slice(0, 150),
        customerName: String(customerName || "").slice(0, 150),
      },
      success_url: `${CLIENT_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${CLIENT_URL}/equipment/${item.slug || item._id}`,
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    res.status(500).json({ message: err.message || "Stripe checkout failed" });
  }
});

// POST /payments/confirm: verify Stripe session, record payment + rental, update stock
router.post("/confirm", async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) {
      return res.status(400).json({ message: "sessionId is required" });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== "paid") {
      return res
        .status(400)
        .json({ message: "Payment has not been completed" });
    }

    const { payments, rentals, equipment } = await getCollections();

    // Idempotency: if already confirmed, return existing record
    const existingPayment = await payments.findOne({
      stripeSessionId: session.id,
    });
    if (existingPayment) {
      return res.json({ confirmed: true, payment: existingPayment });
    }

    const m = session.metadata;
    const eqObjectId = new ObjectId(m.equipmentId);
    const qty = Number(m.quantity);
    const dur = Number(m.duration);
    const totalPrice = Number(m.totalPrice);
    const now = new Date();

    const rentalDoc = {
      equipmentId: eqObjectId,
      equipmentName: m.equipmentName,
      ownerEmail: m.ownerEmail,
      customerEmail: m.customerEmail,
      customerName: m.customerName,
      startDate: m.startDate,
      endDate: m.endDate || computeEndDate(m.startDate, m.rentalType, dur),
      duration: dur,
      rentalType: m.rentalType,
      quantity: qty,
      contactNumber: m.contactNumber || "",
      deliveryAddress: m.deliveryAddress || "",
      additionalNotes: m.additionalNotes || "",
      totalPrice,
      totalAmount: totalPrice,
      paymentStatus: "paid",
      rentalStatus: "confirmed",
      bookingStatus: "Confirmed",
      status: "Confirmed",
      stripeSessionId: session.id,
      bookingDate: now,
      createdAt: now,
    };

    const rentalResult = await rentals.insertOne(rentalDoc);

    const paymentDoc = {
      rentalId: rentalResult.insertedId,
      equipmentId: eqObjectId,
      equipmentName: m.equipmentName,
      customerEmail: m.customerEmail,
      ownerEmail: m.ownerEmail,
      amount: totalPrice,
      currency: session.currency || "usd",
      transactionId: session.payment_intent,
      stripeSessionId: session.id,
      status: "paid",
      paidAt: now,
    };

    await payments.insertOne(paymentDoc);

    // Decrement availableQuantity (clamped at 0)
    await equipment.updateOne(
      { _id: eqObjectId, availableQuantity: { $gte: qty } },
      { $inc: { availableQuantity: -qty } },
    );

    res.json({
      confirmed: true,
      rental: { _id: rentalResult.insertedId, ...rentalDoc },
      payment: paymentDoc,
    });
  } catch (err) {
    res
      .status(500)
      .json({ message: err.message || "Failed to confirm payment" });
  }
});

export default router;
