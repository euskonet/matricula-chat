package org.matriculachat.app;

import android.util.Base64;

import androidx.annotation.NonNull;

import com.android.billingclient.api.AcknowledgePurchaseParams;
import com.android.billingclient.api.BillingClient;
import com.android.billingclient.api.BillingClientStateListener;
import com.android.billingclient.api.BillingFlowParams;
import com.android.billingclient.api.BillingResult;
import com.android.billingclient.api.PendingPurchasesParams;
import com.android.billingclient.api.ProductDetails;
import com.android.billingclient.api.Purchase;
import com.android.billingclient.api.PurchasesUpdatedListener;
import com.android.billingclient.api.QueryProductDetailsParams;
import com.android.billingclient.api.QueryPurchasesParams;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Compras de Google Play (Matrícula Chat Pro). Sin servidor: la compra se
 * comprueba en el dispositivo. Si se rellena PLAY_PUBLIC_KEY, además se
 * verifica la firma de Google de cada compra.
 */
@CapacitorPlugin(name = "Billing")
public class BillingPlugin extends Plugin implements PurchasesUpdatedListener {

    /** Play Console → Monetizar → Configuración de monetización → Licencias (clave pública en base64). */
    private static final String PLAY_PUBLIC_KEY = "";

    private BillingClient client;
    private final Map<String, ProductDetails> details = new ConcurrentHashMap<>();
    private volatile PluginCall pendingPurchase;

    @Override
    public void load() {
        client = BillingClient.newBuilder(getContext())
                .setListener(this)
                .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
                .enableAutoServiceReconnection()
                .build();
    }

    private void withClient(PluginCall call, Runnable action) {
        if (client.isReady()) { action.run(); return; }
        client.startConnection(new BillingClientStateListener() {
            @Override public void onBillingSetupFinished(@NonNull BillingResult r) {
                if (r.getResponseCode() == BillingClient.BillingResponseCode.OK) action.run();
                else call.reject("Google Play no está disponible (" + r.getResponseCode() + ")");
            }
            @Override public void onBillingServiceDisconnected() {
                // enableAutoServiceReconnection reconecta en la siguiente llamada
            }
        });
    }

    private void queryDetails(List<String> ids, PluginCall call, Runnable then) {
        List<QueryProductDetailsParams.Product> products = new ArrayList<>();
        for (String id : ids) {
            products.add(QueryProductDetailsParams.Product.newBuilder()
                    .setProductId(id).setProductType(BillingClient.ProductType.INAPP).build());
        }
        client.queryProductDetailsAsync(QueryProductDetailsParams.newBuilder().setProductList(products).build(),
                (result, detailsResult) -> {
                    if (result.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                        call.reject("No se han podido cargar los productos (" + result.getResponseCode() + ")");
                        return;
                    }
                    for (ProductDetails d : detailsResult.getProductDetailsList()) details.put(d.getProductId(), d);
                    then.run();
                });
    }

    @PluginMethod
    public void getProducts(PluginCall call) {
        JSArray arr = call.getArray("ids");
        List<String> ids = new ArrayList<>();
        try { if (arr != null) ids.addAll(arr.<String>toList()); } catch (Exception ignored) { }
        if (ids.isEmpty()) { call.reject("Faltan los productos"); return; }
        withClient(call, () -> queryDetails(ids, call, () -> {
            JSArray out = new JSArray();
            for (String id : ids) {
                ProductDetails d = details.get(id);
                if (d == null) continue;
                ProductDetails.OneTimePurchaseOfferDetails offer = d.getOneTimePurchaseOfferDetails();
                JSObject o = new JSObject();
                o.put("id", id);
                o.put("title", d.getName());
                o.put("price", offer != null ? offer.getFormattedPrice() : "");
                out.put(o);
            }
            JSObject res = new JSObject();
            res.put("products", out);
            call.resolve(res);
        }));
    }

    @PluginMethod
    public void purchase(PluginCall call) {
        String id = call.getString("productId");
        if (id == null) { call.reject("Falta el producto"); return; }
        if (pendingPurchase != null) { call.reject("Ya hay una compra en curso"); return; }
        withClient(call, () -> {
            Runnable launch = () -> {
                ProductDetails d = details.get(id);
                if (d == null) { call.reject("Producto no disponible"); return; }
                List<BillingFlowParams.ProductDetailsParams> list = new ArrayList<>();
                list.add(BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails(d).build());
                BillingFlowParams params = BillingFlowParams.newBuilder().setProductDetailsParamsList(list).build();
                pendingPurchase = call;
                getActivity().runOnUiThread(() -> {
                    BillingResult r = client.launchBillingFlow(getActivity(), params);
                    if (r.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                        pendingPurchase = null;
                        call.reject("No se ha podido abrir Google Play (" + r.getResponseCode() + ")");
                    }
                });
            };
            if (details.containsKey(id)) launch.run();
            else {
                List<String> ids = new ArrayList<>();
                ids.add(id);
                queryDetails(ids, call, launch);
            }
        });
    }

    @PluginMethod
    public void restore(PluginCall call) {
        withClient(call, () -> client.queryPurchasesAsync(
                QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.INAPP).build(),
                (result, purchases) -> {
                    if (result.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                        call.reject("No se han podido consultar las compras (" + result.getResponseCode() + ")");
                        return;
                    }
                    JSObject res = new JSObject();
                    res.put("owned", owned(purchases));
                    call.resolve(res);
                }));
    }

    @Override
    public void onPurchasesUpdated(@NonNull BillingResult result, List<Purchase> purchases) {
        PluginCall call = pendingPurchase;
        pendingPurchase = null;
        int code = result.getResponseCode();
        JSObject res = new JSObject();
        if (code == BillingClient.BillingResponseCode.OK && purchases != null) {
            JSArray owned = owned(purchases);
            boolean pending = false;
            for (Purchase p : purchases) if (p.getPurchaseState() == Purchase.PurchaseState.PENDING) pending = true;
            res.put("state", owned.length() > 0 ? "purchased" : pending ? "pending" : "canceled");
            res.put("owned", owned);
            if (call != null) call.resolve(res);
            notifyListeners("purchasesUpdated", res); // también compras pendientes que se completan más tarde
        } else if (call == null) {
            // nada pendiente que contestar
        } else if (code == BillingClient.BillingResponseCode.USER_CANCELED) {
            res.put("state", "canceled");
            call.resolve(res);
        } else if (code == BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED) {
            res.put("state", "purchased");
            call.resolve(res);
        } else {
            call.reject("La compra no se ha completado (" + code + ")");
        }
    }

    /** Productos comprados y verificados; confirma (acknowledge) los que aún no lo están. */
    private JSArray owned(List<Purchase> purchases) {
        JSArray out = new JSArray();
        if (purchases == null) return out;
        for (Purchase p : purchases) {
            if (p.getPurchaseState() != Purchase.PurchaseState.PURCHASED) continue;
            if (!verify(p.getOriginalJson(), p.getSignature())) continue;
            if (!p.isAcknowledged()) {
                client.acknowledgePurchase(AcknowledgePurchaseParams.newBuilder().setPurchaseToken(p.getPurchaseToken()).build(),
                        r -> { /* si falla, se reintenta en la siguiente consulta */ });
            }
            for (String id : p.getProducts()) out.put(id);
        }
        return out;
    }

    private static boolean verify(String json, String signature) {
        if (PLAY_PUBLIC_KEY.isEmpty()) return true;
        try {
            PublicKey key = KeyFactory.getInstance("RSA")
                    .generatePublic(new X509EncodedKeySpec(Base64.decode(PLAY_PUBLIC_KEY, Base64.DEFAULT)));
            Signature sig = Signature.getInstance("SHA1withRSA");
            sig.initVerify(key);
            sig.update(json.getBytes("UTF-8"));
            return sig.verify(Base64.decode(signature, Base64.DEFAULT));
        } catch (Exception e) {
            return false;
        }
    }
}
