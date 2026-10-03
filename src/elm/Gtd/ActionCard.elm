module Gtd.ActionCard exposing (Config, view)

{-| An Action card as the Action Board draws it (the same classes, so the same look),
for views that show Actions to choose from rather than to move: the tick box selects
the card, or, for a running Pomodoro, completes the Action (`done` then shows it ticked).
-}

import Gtd.Data as Data exposing (Action)
import Gtd.Energy as Energy
import Gtd.Links as Links
import Gtd.Ui as Ui
import Html exposing (Html, article, div, input, span, text)
import Html.Attributes exposing (checked, class, classList, disabled, type_)
import Html.Events exposing (onCheck)


type alias Config msg =
    { today : String
    , selected : Bool

    -- The Action is done: ticked, struck through, and no longer to be ticked.
    , done : Bool
    , select : Bool -> msg

    -- What the tick box is called for screen readers, e.g. "Focus on".
    , selectLabel : String

    -- The Project line under the title, when it helps to name it.
    , project : Maybe String
    , openUrl : String -> msg
    , openNote : String -> msg
    }


view : Config msg -> Action -> Html msg
view config action =
    let
        overdue =
            Maybe.map (\due -> due < config.today) action.due |> Maybe.withDefault False
    in
    article [ classList [ ( "dg-card", True ), ( "dg-choice-card", True ), ( "is-selected", config.selected ), ( "is-done", config.done ) ] ]
        [ div [ class "dg-card-title-row" ]
            [ Ui.labelled (config.selectLabel ++ ": " ++ action.title)
                (input [ type_ "checkbox", class "dg-card-done", checked (config.selected || config.done), disabled config.done, onCheck config.select ] [])
            , span [ class "dg-card-title dg-action-card-title" ]
                (Links.view { openUrl = config.openUrl, openNote = config.openNote } action.title)
            ]
        , Ui.maybeView config.project (\name -> span [ class "dg-project-link dg-choice-card-project" ] [ text name ])
        , div [ class "dg-card-meta" ]
            [ Ui.maybeView (Data.scheduleText config.today action) (\schedule -> span [ class "dg-card-schedule" ] [ text ("🗓 " ++ schedule) ])
            , Ui.maybeView (Maybe.map (\context -> "@" ++ context) action.context) (\shown -> span [] [ text shown ])
            , Ui.maybeView action.energy Energy.badge
            , Ui.maybeView action.due
                (\due ->
                    -- Overdue is said in words and a symbol too, not by colour alone.
                    if overdue then
                        span [ class "is-overdue" ] [ text ("⚠ " ++ due) ]

                    else
                        span [] [ text due ]
                )
            ]
        ]
