module Gtd.ActionStatus exposing
    ( ActionStatus(..)
    , all
    , decoder
    , encode
    , isOpen
    , key
    , label
    , requiresContext
    )

{-| The closed set of statuses an Action file may carry.

The index rejects every other value before a snapshot reaches Elm, so an unknown
status is a protocol error rather than something a view has to render.

Import this qualified — `import Gtd.ActionStatus as ActionStatus exposing (ActionStatus)` —
so that `ActionStatus.Cancelled` never collides with the Project status of the same name.

-}

import Json.Decode as Decode exposing (Decoder)
import Json.Encode as Encode


type ActionStatus
    = Next
    | Waiting
    | Scheduled
    | Done
    | Cancelled


{-| Every status, in the order the editor and card menus present them.
-}
all : List ActionStatus
all =
    [ Next, Waiting, Scheduled, Done, Cancelled ]


key : ActionStatus -> String
key status =
    case status of
        Next ->
            "next"

        Waiting ->
            "waiting"

        Scheduled ->
            "scheduled"

        Done ->
            "done"

        Cancelled ->
            "cancelled"


label : ActionStatus -> String
label status =
    case status of
        Next ->
            "Next"

        Waiting ->
            "Waiting"

        Scheduled ->
            -- Stored as `scheduled`; shown by GTD's name for what must happen on a day or at a time.
            "Calendar"

        Done ->
            "Done"

        Cancelled ->
            "Cancelled"


{-| Only an Action still to be executed needs an execution context: Waiting records
a dependency on someone else, and Done or Cancelled Actions are finished.
-}
requiresContext : ActionStatus -> Bool
requiresContext status =
    status == Next || status == Scheduled


isOpen : ActionStatus -> Bool
isOpen status =
    status /= Done && status /= Cancelled


decoder : Decoder ActionStatus
decoder =
    Decode.string
        |> Decode.andThen
            (\raw ->
                case List.filter (\candidate -> key candidate == raw) all of
                    found :: _ ->
                        Decode.succeed found

                    [] ->
                        Decode.fail ("Unknown Action status: " ++ raw)
            )


encode : ActionStatus -> Encode.Value
encode =
    key >> Encode.string
