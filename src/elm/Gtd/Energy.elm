module Gtd.Energy exposing
    ( Energy(..)
    , all
    , badge
    , decoder
    , fromKey
    , key
    , label
    , symbol
    )

{-| How much energy an Action takes: one of three levels, or none at all.
-}

import Html exposing (Html, span, text)
import Html.Attributes exposing (attribute, class)
import Json.Decode as Decode exposing (Decoder)


type Energy
    = Low
    | Medium
    | High


all : List Energy
all =
    [ Low, Medium, High ]


key : Energy -> String
key energy =
    case energy of
        Low ->
            "low"

        Medium ->
            "medium"

        High ->
            "high"


label : Energy -> String
label energy =
    case energy of
        Low ->
            "Low"

        Medium ->
            "Medium"

        High ->
            "High"


{-| One bolt per level, so the level reads from the count and not from colour.
-}
symbol : Energy -> String
symbol energy =
    case energy of
        Low ->
            "⚡"

        Medium ->
            "⚡⚡"

        High ->
            "⚡⚡⚡"


fromKey : String -> Maybe Energy
fromKey raw =
    List.filter (\energy -> key energy == raw) all |> List.head


{-| The symbol shown on an Action card, named for screen readers.
-}
badge : Energy -> Html msg
badge energy =
    span [ class ("dg-energy dg-energy-" ++ key energy) ]
        [ span [ attribute "aria-hidden" "true" ] [ text (symbol energy) ]
        -- `Gtd.Ui.srOnly`, which this module cannot import: `Gtd.Ui` depends on `Gtd.Data`.
        , span [ class "dg-sr-only" ] [ text (label energy ++ " energy") ]
        ]


decoder : Decoder Energy
decoder =
    Decode.string
        |> Decode.andThen
            (\raw ->
                case fromKey raw of
                    Just energy ->
                        Decode.succeed energy

                    Nothing ->
                        Decode.fail ("Unknown energy: " ++ raw)
            )
