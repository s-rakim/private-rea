package net.tailchat.client;

import java.io.IOException;

/** A non-2xx answer from the Tailchat API. */
public final class ApiException extends IOException {
    private final int status;

    public ApiException(int status, String message) {
        super(message);
        this.status = status;
    }

    public int status() {
        return status;
    }
}
