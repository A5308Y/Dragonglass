module Gtd.Host exposing
    ( Outcome
    , RequestId
    , Requests
    , envelope
    , isClosing
    , issue
    , noRequests
    , outcomeDecoder
    , pending
    , protocolVersion
    , resolve
    )

{-| The request side of the Elm ↔ host protocol.

Every command Elm sends carries a request id, and the host answers with an
outcome for exactly that id. `Requests` keeps the work a view is waiting on
beside the id that will finish it, so a reply can never be matched against a
request that was never made.

-}

import Dict exposing (Dict)
import Json.Decode as Decode exposing (Decoder)
import Json.Encode as Encode


protocolVersion : Int
protocolVersion =
    2


type RequestId
    = RequestId Int


{-| The commands a view is waiting on, each tagged with what to do when it lands.
-}
type Requests pending
    = Requests { next : Int, waiting : Dict Int pending }


noRequests : Requests pending
noRequests =
    Requests { next = 1, waiting = Dict.empty }


{-| Reserves the next id and records what its reply should finish.
-}
issue : pending -> Requests pending -> ( RequestId, Requests pending )
issue work (Requests state) =
    ( RequestId state.next
    , Requests { next = state.next + 1, waiting = Dict.insert state.next work state.waiting }
    )


{-| Takes a request out of flight, with the work it was carrying.
-}
resolve : RequestId -> Requests pending -> ( Maybe pending, Requests pending )
resolve (RequestId id) (Requests state) =
    ( Dict.get id state.waiting
    , Requests { state | waiting = Dict.remove id state.waiting }
    )


{-| Everything still in flight.
-}
pending : Requests pending -> List pending
pending (Requests state) =
    Dict.values state.waiting


{-| How a command travels to the host.
-}
envelope : RequestId -> Encode.Value -> Encode.Value
envelope (RequestId id) command =
    Encode.object
        [ ( "protocolVersion", Encode.int protocolVersion )
        , ( "requestId", Encode.string (String.fromInt id) )
        , ( "command", command )
        ]


{-| What the host reports back about one request.
-}
type alias Outcome =
    { requestId : RequestId, result : Result String Decode.Value }


outcomeDecoder : Decoder Outcome
outcomeDecoder =
    Decode.map3 (\id ok error -> ( id, ok, error ))
        (Decode.field "requestId" requestIdDecoder)
        (Decode.field "ok" Decode.bool)
        (Decode.oneOf [ Decode.field "error" Decode.string, Decode.succeed "The GTD operation failed." ])
        |> Decode.andThen
            (\( id, ok, error ) ->
                if ok then
                    Decode.map (\value -> Outcome id (Ok value))
                        (Decode.oneOf [ Decode.field "value" Decode.value, Decode.succeed Encode.null ])

                else
                    Decode.succeed (Outcome id (Err error))
            )


requestIdDecoder : Decoder RequestId
requestIdDecoder =
    Decode.string
        |> Decode.andThen
            (\raw ->
                case String.toInt raw of
                    Just id ->
                        Decode.succeed (RequestId id)

                    Nothing ->
                        Decode.fail ("Unknown request id: " ++ raw)
            )


{-| Whether a host event says the view's tab was closed. Elm can't stop a program, so a
closed view keeps running unseen; on this it switches off its timers, or every closed tab
would go on ticking, and redrawing into nothing, until Obsidian quits.
-}
isClosing : Decode.Value -> Bool
isClosing value =
    Decode.decodeValue (Decode.field "type" Decode.string) value == Ok "closed"
