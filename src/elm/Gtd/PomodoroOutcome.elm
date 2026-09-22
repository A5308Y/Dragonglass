module Gtd.PomodoroOutcome exposing (PomodoroOutcome(..), all, decoder, encode, key, label, symbol)

{-| How a Pomodoro went, as its wrap-up records it.
-}

import Json.Decode as Decode exposing (Decoder)
import Json.Encode as Encode


type PomodoroOutcome
    = Achieved
    | Partly
    | Missed


all : List PomodoroOutcome
all =
    [ Achieved, Partly, Missed ]


key : PomodoroOutcome -> String
key outcome =
    case outcome of
        Achieved ->
            "achieved"

        Partly ->
            "partly"

        Missed ->
            "missed"


label : PomodoroOutcome -> String
label outcome =
    case outcome of
        Achieved ->
            "Achieved"

        Partly ->
            "Partly"

        Missed ->
            "Not really"


{-| Shown next to the label, so an outcome never reads by colour alone.
-}
symbol : PomodoroOutcome -> String
symbol outcome =
    case outcome of
        Achieved ->
            "✓"

        Partly ->
            "◐"

        Missed ->
            "✕"


decoder : Decoder PomodoroOutcome
decoder =
    Decode.string
        |> Decode.andThen
            (\raw ->
                case List.filter (\candidate -> key candidate == raw) all of
                    found :: _ ->
                        Decode.succeed found

                    [] ->
                        Decode.fail ("Unknown Pomodoro outcome: " ++ raw)
            )


encode : PomodoroOutcome -> Encode.Value
encode =
    key >> Encode.string
